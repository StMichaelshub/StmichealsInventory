import { mongooseConnect } from "@/lib/mongoose";
import { Transaction } from "@/models/Transactions";
import JournalEntry from "@/models/JournalEntry";
import { authMiddleware, isAdmin, isStaff } from "@/lib/auth-middleware";
import { restockSaleInventoryOnce, unlinkTransactionFromTill } from "@/lib/tillLedger";
import { postRefundEntry } from "@/lib/accounting";

export default async function handler(req, res) {
  const authError = authMiddleware(req, res);
  if (authError) return authError;

  if (!isStaff(req)) {
    return res.status(403).json({ error: "Insufficient permissions" });
  }

  await mongooseConnect();

  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ error: "Transaction ID is required" });
  }

  if (req.method === "PUT") {
    try {
      const { status, subStatus, refundReason } = req.body || {};

      const validStatuses = ["held", "completed", "refunded"];
      if (status && !validStatuses.includes(status)) {
        return res
          .status(400)
          .json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
      }

      const validSubStatuses = ["none", "edited", "void"];
      if (subStatus && !validSubStatuses.includes(subStatus)) {
        return res
          .status(400)
          .json({ error: `Invalid subStatus. Must be one of: ${validSubStatuses.join(", ")}` });
      }

      const transaction = await Transaction.findById(id).lean();
      if (!transaction) {
        return res.status(404).json({ error: "Transaction not found" });
      }

      if (status === "completed" && transaction.status === "refunded") {
        return res.status(400).json({
          error: "Transition from refunded to completed is not supported",
        });
      }

      const isVoidOfHeldSale = status === "refunded" && transaction.status === "held";

      // Anything that changes a real sale (refund, status or sub-status edits) is admin only.
      // Other staff use "Request refund", which emails an admin for approval.
      if (!isVoidOfHeldSale && !isAdmin(req)) {
        return res.status(403).json({
          error: "Only an admin can change a completed sale directly. Use \"Request refund\" so an admin can approve it.",
        });
      }

      let updated;

      if (status === "refunded" && transaction.status !== "refunded") {
        // Claim the refund atomically so a double click cannot refund (and restock) twice.
        updated = await Transaction.findOneAndUpdate(
          { _id: transaction._id, status: { $ne: "refunded" } },
          {
            $set: {
              status: "refunded",
              subStatus: subStatus || "void",
              refundReason: refundReason || transaction.refundReason || (isVoidOfHeldSale ? "Held sale voided" : "Refunded by admin"),
              refundedAt: new Date(),
              updatedAt: new Date(),
              ...(isVoidOfHeldSale ? { voidedAt: new Date(), voidReason: refundReason || "Voided from admin" } : {}),
            },
          },
          { new: true, runValidators: true }
        );

        if (!updated) {
          const latest = await Transaction.findById(id);
          return res.status(200).json({ success: true, alreadyRefunded: true, transaction: latest });
        }

        if (["completed", "credit"].includes(transaction.status)) {
          await restockSaleInventoryOnce(updated._id, updated.items || []);
        }

        // Take the sale off its till so the till, its end-of-day report and the
        // POS all show the same totals.
        if (transaction.status === "completed" && transaction.tillId) {
          await unlinkTransactionFromTill(transaction.tillId, updated._id);
        }
      } else {
        const updateData = { updatedAt: new Date() };
        if (status) updateData.status = status;
        if (subStatus) updateData.subStatus = subStatus;
        if (refundReason) updateData.refundReason = refundReason;

        updated = await Transaction.findByIdAndUpdate(id, updateData, {
          new: true,
          runValidators: true,
        });
      }

      // Auto-post refund journal entry
      if (status === "refunded" && updated && !isVoidOfHeldSale) {
        try {
          await postRefundEntry(updated);
        } catch (acctErr) {
          console.error("Accounting auto-post failed for refund:", updated._id, acctErr.message);
        }
      }

      return res.status(200).json({ success: true, transaction: updated });
    } catch (err) {
      console.error("Error updating transaction:", err);
      return res.status(500).json({ error: "Failed to update transaction" });
    }
  }

  if (req.method === "GET") {
    try {
      const transaction = await Transaction.findById(id);
      if (!transaction) {
        return res.status(404).json({ error: "Transaction not found" });
      }
      return res.status(200).json(transaction);
    } catch (err) {
      console.error("Error fetching transaction:", err);
      return res.status(500).json({ error: "Failed to fetch transaction" });
    }
  }

  if (req.method === "DELETE") {
    if (!isAdmin(req)) {
      return res.status(403).json({ error: "Only an admin can delete transactions." });
    }

    try {
      const transaction = await Transaction.findById(id);
      if (!transaction) {
        return res.status(404).json({ error: "Transaction not found" });
      }

      // Only allow deletion of refunded transactions
      if (transaction.status !== "refunded") {
        return res.status(400).json({
          error: "Only refunded transactions can be deleted. Refund the transaction first.",
        });
      }

      // Remove all related journal entries (SALE, REFUND, CREDIT_SALE, CREDIT_PAYMENT)
      await JournalEntry.deleteMany({ referenceId: transaction._id });

      // Delete the transaction itself
      await Transaction.findByIdAndDelete(id);

      return res.status(200).json({ success: true, message: "Transaction and related records deleted." });
    } catch (err) {
      console.error("Error deleting transaction:", err);
      return res.status(500).json({ error: "Failed to delete transaction" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
