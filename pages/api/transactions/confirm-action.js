import { mongooseConnect } from "@/lib/mongodb";
import { Transaction } from "@/models/Transactions";
import PendingTransactionAction from "@/models/PendingTransactionAction";
import { postRefundEntry } from "@/lib/accounting";
import {
  applySaleInventoryOnce,
  linkTransactionToTill,
  restockSaleInventoryOnce,
  unlinkTransactionFromTill,
} from "@/lib/tillLedger";

/**
 * Admin approval link for staff refund/edit requests (sent by email).
 *
 * GET  shows what will happen and a button. It never changes anything, because
 *      email security scanners (Outlook, Gmail) open links automatically.
 * POST performs the approval or rejection. The request is claimed atomically so
 *      it can only ever be processed once.
 */

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const formatNaira = (value) =>
  `₦${Number(value || 0).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).send("Method not allowed");
  }

  const source = req.method === "POST" ? req.body || {} : req.query || {};
  const token = typeof source.token === "string" ? source.token.trim() : "";
  const decision = typeof source.decision === "string" ? source.decision : "";

  if (!token || !["approve", "reject"].includes(decision)) {
    return renderPage(res, "Invalid Request", "The confirmation link is invalid or malformed.", "error");
  }

  try {
    await mongooseConnect();

    const pendingAction = await PendingTransactionAction.findOne({ confirmationToken: token }).lean();

    if (!pendingAction) {
      return renderPage(res, "Action Not Found", "This confirmation link has expired or does not exist.", "error");
    }

    if (pendingAction.status !== "pending") {
      const label = {
        approved: "already approved",
        rejected: "already rejected",
        processing: "being processed",
        expired: "expired",
      }[pendingAction.status] || pendingAction.status;
      const when = pendingAction.processedAt
        ? ` on ${new Date(pendingAction.processedAt).toLocaleString("en-NG")}`
        : "";
      return renderPage(res, "Already Processed", `This request was ${escapeHtml(label)}${escapeHtml(when)}.`, "info");
    }

    if (new Date() > new Date(pendingAction.expiresAt)) {
      await PendingTransactionAction.updateOne(
        { _id: pendingAction._id, status: "pending" },
        { $set: { status: "expired", processedAt: new Date() } }
      );
      return renderPage(res, "Link Expired", "This confirmation link has expired. The staff member will need to submit a new request.", "error");
    }

    const transaction = await Transaction.findById(pendingAction.transactionId).lean();

    if (req.method === "GET") {
      return renderConfirmPage(res, { pendingAction, transaction, token, decision });
    }

    // ---- POST: claim the request so it is processed exactly once ----
    const claimed = await PendingTransactionAction.findOneAndUpdate(
      { _id: pendingAction._id, status: "pending", expiresAt: { $gt: new Date() } },
      { $set: { status: "processing" } },
      { new: true }
    );

    if (!claimed) {
      return renderPage(res, "Already Processed", "This request has already been handled.", "info");
    }

    const finish = (status) =>
      PendingTransactionAction.updateOne(
        { _id: claimed._id },
        { $set: { status, processedAt: new Date() } }
      );

    try {
      if (!transaction) {
        await finish("rejected");
        return renderPage(res, "Transaction Not Found", "The associated transaction no longer exists.", "error");
      }

      if (decision === "reject") {
        await finish("rejected");
        return renderPage(
          res,
          "Request Rejected",
          `The ${escapeHtml(claimed.actionType)} request has been rejected. No changes were made.`,
          "warning"
        );
      }

      if (claimed.actionType === "edit") {
        await approveEdit(transaction, claimed.editPayload || {});
        await finish("approved");
        return renderPage(
          res,
          "Edit Approved",
          "The transaction has been updated. Stock and till totals were adjusted to match.",
          "success"
        );
      }

      if (claimed.actionType === "refund") {
        const alreadyRefunded = !(await approveRefund(transaction, claimed.reason));
        await finish("approved");
        return renderPage(
          res,
          alreadyRefunded ? "Already Refunded" : "Refund Approved",
          alreadyRefunded
            ? "This sale had already been refunded. Nothing else was changed."
            : "The sale has been refunded, stock was restocked and the till totals were updated.",
          alreadyRefunded ? "info" : "success"
        );
      }

      await finish("rejected");
      return renderPage(res, "Unknown Action", "The action type is not recognized.", "error");
    } catch (error) {
      // Release the claim so the admin can try the link again.
      await PendingTransactionAction.updateOne({ _id: claimed._id }, { $set: { status: "pending" } });
      throw error;
    }
  } catch (err) {
    console.error("Confirm action error:", err);
    return renderPage(res, "Server Error", "An error occurred while processing this request. Please try again or contact support.", "error");
  }
}

async function approveEdit(transaction, editPayload) {
  const affectsStock = ["completed", "credit"].includes(transaction.status);
  const newItems = Array.isArray(editPayload.items) ? editPayload.items : null;

  // Put the old lines back before applying the edited ones, so stock matches the new sale.
  if (affectsStock && newItems) {
    await restockSaleInventoryOnce(transaction._id, transaction.items || []);
  }

  const updateData = { status: "completed", subStatus: "edited", updatedAt: new Date() };
  if (newItems) updateData.items = newItems;
  if (editPayload.total !== undefined) updateData.total = editPayload.total;
  if (editPayload.subtotal !== undefined) updateData.subtotal = editPayload.subtotal;
  if (editPayload.tax !== undefined) updateData.tax = editPayload.tax;
  if (editPayload.discount !== undefined) updateData.discount = editPayload.discount;
  if (editPayload.customerName !== undefined) updateData.customerName = editPayload.customerName;
  if (editPayload.discountReason !== undefined) updateData.discountReason = editPayload.discountReason;

  const updated = await Transaction.findByIdAndUpdate(transaction._id, updateData, {
    new: true,
    runValidators: true,
  });

  if (affectsStock && newItems) {
    await applySaleInventoryOnce(updated._id, updated.items || []);
  }

  if (updated.tillId) {
    await linkTransactionToTill(updated.tillId, updated._id);
  }
}

/** Returns false if the sale was already refunded. */
async function approveRefund(transaction, reason) {
  const refunded = await Transaction.findOneAndUpdate(
    { _id: transaction._id, status: { $ne: "refunded" } },
    {
      $set: {
        status: "refunded",
        subStatus: "void",
        refundedAt: new Date(),
        refundReason: reason || "Admin-approved refund",
        updatedAt: new Date(),
      },
    },
    { new: true, runValidators: true }
  );

  if (!refunded) return false;

  if (["completed", "credit"].includes(transaction.status)) {
    await restockSaleInventoryOnce(refunded._id, refunded.items || []);
  }

  if (transaction.status === "completed" && transaction.tillId) {
    await unlinkTransactionFromTill(transaction.tillId, refunded._id);
  }

  try {
    await postRefundEntry(refunded);
  } catch (acctErr) {
    console.error("Accounting auto-post failed for approved refund:", refunded._id, acctErr.message);
  }

  return true;
}

function renderConfirmPage(res, { pendingAction, transaction, token, decision }) {
  const isApprove = decision === "approve";
  const action = pendingAction.actionType === "edit" ? "edit" : "refund";
  const editTotal = pendingAction.editPayload?.total;

  const rows = [
    ["Request", action === "edit" ? "Edit sale" : "Refund sale"],
    ["Requested by", pendingAction.requestedBy || "Staff"],
    ["Reason", pendingAction.reason || "No reason given"],
    ["Sale total", transaction ? formatNaira(transaction.total) : "Sale not found"],
    ...(action === "edit" && editTotal !== undefined ? [["New total", formatNaira(editTotal)]] : []),
    ["Sale date", transaction?.createdAt ? new Date(transaction.createdAt).toLocaleString("en-NG") : "-"],
    ["Staff on sale", transaction?.staffName || "-"],
  ]
    .map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td><strong>${escapeHtml(value)}</strong></td></tr>`)
    .join("");

  const buttonLabel = isApprove ? (action === "edit" ? "Approve edit" : "Approve refund") : "Reject request";
  const buttonColor = isApprove ? "#059669" : "#dc2626";

  const body = `
    <table class="details">${rows}</table>
    <form method="POST" action="/api/transactions/confirm-action">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <input type="hidden" name="decision" value="${escapeHtml(decision)}">
      <button type="submit" style="background:${buttonColor}">${escapeHtml(buttonLabel)}</button>
    </form>
    <p class="hint">Nothing changes until you press the button.</p>`;

  return sendHtml(res, `${isApprove ? "Approve" : "Reject"} ${action} request`, body, isApprove ? "info" : "warning");
}

function renderPage(res, title, message, type = "info") {
  return sendHtml(res, title, `<div class="alert">${message}</div>`, type);
}

function sendHtml(res, title, bodyHtml, type = "info") {
  const colors = {
    success: { bg: "#ecfdf5", border: "#059669", text: "#065f46" },
    error: { bg: "#fef2f2", border: "#dc2626", text: "#991b1b" },
    warning: { bg: "#fffbeb", border: "#d97706", text: "#92400e" },
    info: { bg: "#eff6ff", border: "#2563eb", text: "#1e40af" },
  };

  const c = colors[type] || colors.info;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex">
  <title>${escapeHtml(title)} — Transaction Action</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f3f4f6; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
    .card { background: white; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.1); max-width: 480px; width: 100%; overflow: hidden; }
    .card-header { background: ${c.border}; color: white; padding: 24px; text-align: center; }
    .card-header h1 { font-size: 1.4rem; font-weight: 700; }
    .card-body { padding: 28px 24px; }
    .alert { background: ${c.bg}; border-left: 4px solid ${c.border}; color: ${c.text}; padding: 16px; border-radius: 8px; font-size: 15px; line-height: 1.6; }
    .details { width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 20px; }
    .details td { padding: 8px 0; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
    .details td:first-child { color: #6b7280; width: 40%; }
    button { width: 100%; border: 0; color: white; font-size: 16px; font-weight: 700; padding: 14px; border-radius: 10px; cursor: pointer; }
    .hint { margin-top: 12px; text-align: center; color: #6b7280; font-size: 13px; }
    .footer { text-align: center; padding: 16px 24px 24px; color: #9ca3af; font-size: 13px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="card-header"><h1>${escapeHtml(title)}</h1></div>
    <div class="card-body">${bodyHtml}</div>
    <div class="footer">Inventory Admin</div>
  </div>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(html);
}
