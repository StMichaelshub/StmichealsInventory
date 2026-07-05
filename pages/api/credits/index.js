import mongoose from "mongoose";
import Transaction from "@/models/Transactions";
import Customer from "@/models/Customer";
import Product from "@/models/Product";
import { StockMovement } from "@/models/StockMovement";
import { mongooseConnect } from "@/lib/mongodb";
import { authMiddleware, isStaff } from "@/lib/auth-middleware";
import { postCreditRecoveryEntry, postCreditSaleEntry } from "@/lib/accounting";
import { reverseInventoryForRefund } from "@/lib/syncPackQty";

function toMoney(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function getPaymentTotal(transaction = {}) {
  const payments = Array.isArray(transaction.creditPayments) ? transaction.creditPayments : [];
  if (payments.length > 0) {
    return toMoney(payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0));
  }
  return toMoney(transaction.creditPaidAmount || 0);
}

function getCreditBalance(transaction = {}) {
  const total = toMoney(transaction.creditOriginalTotal || transaction.total || 0);
  const paid = getPaymentTotal(transaction);
  return Math.max(0, toMoney(total - paid));
}

function getCreditStatus(balance, paid, previousStatus) {
  if (previousStatus === "written_off") return "written_off";
  if (balance <= 0) return "paid";
  if (paid > 0) return "partly_paid";
  return "open";
}

async function recalculateCustomerBalance(customerId) {
  if (!customerId || !mongoose.Types.ObjectId.isValid(String(customerId))) return null;

  const customerObjectId = new mongoose.Types.ObjectId(String(customerId));
  const openCredits = await Transaction.find({
    status: "credit",
    creditCustomerId: customerObjectId,
    creditStatus: { $nin: ["paid", "written_off"] },
  }).select("creditBalance total creditOriginalTotal creditPaidAmount creditPayments");

  const creditBalance = toMoney(
    openCredits.reduce((sum, transaction) => sum + getCreditBalance(transaction), 0)
  );

  await Customer.findByIdAndUpdate(customerObjectId, {
    creditBalance,
    isCreditCustomer: true,
    type: "CREDIT",
    updatedAt: new Date(),
  });

  return creditBalance;
}

function serializeCredit(transaction, customerById = new Map()) {
  const customerId = String(transaction.creditCustomerId || transaction.customerId || "");
  const customer = customerById.get(customerId);
  const paidAmount = getPaymentTotal(transaction);
  const balance = getCreditBalance(transaction);
  const total = toMoney(transaction.creditOriginalTotal || transaction.total || 0);

  return {
    ...transaction,
    customerId,
    customerName: transaction.creditCustomerName || transaction.customerName || customer?.name || "Walk-in credit",
    customerPhone: customer?.phone || "",
    customerEmail: customer?.email || "",
    creditOriginalTotal: total,
    creditPaidAmount: paidAmount,
    creditBalance: balance,
    creditStatus: getCreditStatus(balance, paidAmount, transaction.creditStatus),
    items: transaction.items || [],
    creditReturnedItems: transaction.creditReturnedItems || [],
  };
}

export default async function handler(req, res) {
  const authError = authMiddleware(req, res);
  if (authError) return authError;

  if (!isStaff(req)) {
    return res.status(403).json({ success: false, message: "Insufficient permissions" });
  }

  try {
    await mongooseConnect();

    if (req.method === "GET") {
      const [creditTransactions, creditCustomers] = await Promise.all([
        Transaction.find({
          $or: [
            { status: "credit" },
            { creditStatus: { $in: ["open", "partly_paid", "paid", "written_off"] } },
          ],
        }).sort({ createdAt: -1 }).lean(),
        Customer.find({
          $or: [{ isCreditCustomer: true }, { type: "CREDIT" }],
        }).sort({ name: 1 }).lean(),
      ]);

      const customerById = new Map(creditCustomers.map((customer) => [String(customer._id), customer]));
      const credits = creditTransactions.map((transaction) => serializeCredit(transaction, customerById));
      const activeCredits = credits.filter((credit) => !["paid", "written_off"].includes(credit.creditStatus));
      const recoveredCredits = credits.filter((credit) => credit.creditStatus === "paid");

      const summary = {
        creditCustomers: creditCustomers.length,
        totalCreditIssued: toMoney(credits.reduce((sum, credit) => sum + Number(credit.creditOriginalTotal || 0), 0)),
        totalRecovered: toMoney(credits.reduce((sum, credit) => sum + Number(credit.creditPaidAmount || 0), 0)),
        outstandingBalance: toMoney(activeCredits.reduce((sum, credit) => sum + Number(credit.creditBalance || 0), 0)),
        activeCredits: activeCredits.length,
        recoveredCredits: recoveredCredits.length,
        partialCredits: credits.filter((credit) => credit.creditStatus === "partly_paid").length,
      };

      return res.status(200).json({
        success: true,
        credits,
        customers: creditCustomers,
        summary,
      });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ success: false, message: "Method not allowed" });
    }

    const action = String(req.body?.action || "").trim();

    if (action === "create-customer") {
      const { name, phone, email, address, creditLimit, creditNotes } = req.body || {};
      if (!name || !phone) {
        return res.status(400).json({ success: false, message: "Name and phone are required" });
      }

      if (email) {
        const existing = await Customer.findOne({ email });
        if (existing) {
          return res.status(409).json({ success: false, message: "Customer with this email already exists" });
        }
      }

      const customer = await Customer.create({
        name,
        phone,
        email: email || undefined,
        address: address || "",
        type: "CREDIT",
        isCreditCustomer: true,
        creditLimit: toMoney(creditLimit),
        creditBalance: 0,
        creditNotes: creditNotes || "",
      });

      return res.status(201).json({ success: true, customer });
    }

    if (action === "create-debt") {
      const { customerId, amount, dueDate, notes, reference } = req.body || {};
      const safeAmount = toMoney(amount);
      if (!customerId || !mongoose.Types.ObjectId.isValid(String(customerId)) || safeAmount <= 0) {
        return res.status(400).json({ success: false, message: "Valid customer and amount are required" });
      }

      const customer = await Customer.findById(customerId).lean();
      if (!customer) {
        return res.status(404).json({ success: false, message: "Customer not found" });
      }

      const transaction = await Transaction.create({
        items: [{ name: reference || "Opening credit balance", qty: 1, quantity: 1, salePriceIncTax: safeAmount, price: safeAmount }],
        total: safeAmount,
        subtotal: safeAmount,
        tax: 0,
        discount: 0,
        amountPaid: 0,
        change: 0,
        tenderType: "CREDIT",
        tenderPayments: [],
        staffName: req.user?.name || "Admin",
        location: "Credit Management",
        device: "Admin",
        transactionType: "pos",
        status: "credit",
        customerId: customer._id,
        customerName: customer.name,
        creditStatus: "open",
        creditCustomerId: customer._id,
        creditCustomerName: customer.name,
        creditOriginalTotal: safeAmount,
        creditPaidAmount: 0,
        creditBalance: safeAmount,
        creditDueDate: dueDate ? new Date(dueDate) : null,
        creditNotes: notes || "",
        createdAt: new Date(),
      });

      await recalculateCustomerBalance(customer._id);

      try {
        await postCreditSaleEntry(transaction);
      } catch (accountingError) {
        console.error("Accounting auto-post failed for created credit debt:", transaction._id, accountingError.message);
      }

      return res.status(201).json({ success: true, transaction });
    }

    if (action === "record-payment") {
      const { transactionId, amount, tenderType, reference, notes, paidAt } = req.body || {};
      const safeAmount = toMoney(amount);
      if (!transactionId || !mongoose.Types.ObjectId.isValid(String(transactionId)) || safeAmount <= 0) {
        return res.status(400).json({ success: false, message: "Valid transaction and payment amount are required" });
      }

      const transaction = await Transaction.findById(transactionId);
      if (!transaction) {
        return res.status(404).json({ success: false, message: "Credit transaction not found" });
      }

      const existingPayments = Array.isArray(transaction.creditPayments) ? transaction.creditPayments : [];
      const sequence = existingPayments.length + 1;
      const paymentDate = paidAt ? new Date(paidAt) : new Date();
      transaction.creditPayments.push({
        amount: safeAmount,
        tenderType: tenderType || "CASH",
        tenderName: tenderType || "CASH",
        reference: reference || "",
        notes: notes || "",
        paidAt: Number.isNaN(paymentDate.getTime()) ? new Date() : paymentDate,
        recordedBy: req.user?._id || null,
        recordedByName: req.user?.name || "Admin",
        sequence,
      });

      const paidAmount = getPaymentTotal(transaction);
      const balance = getCreditBalance(transaction);
      transaction.creditPaidAmount = paidAmount;
      transaction.creditBalance = balance;
      transaction.creditStatus = getCreditStatus(balance, paidAmount, transaction.creditStatus);
      if (transaction.creditStatus === "paid") {
        transaction.creditPaidAt = Number.isNaN(paymentDate.getTime()) ? new Date() : paymentDate;
      }

      await transaction.save();

      if (transaction.creditCustomerId) {
        const customerBalance = await recalculateCustomerBalance(transaction.creditCustomerId);
        await Customer.findByIdAndUpdate(transaction.creditCustomerId, {
          lastCreditPaymentAt: new Date(),
          creditBalance: customerBalance,
        });
      }

      try {
        await postCreditRecoveryEntry(transaction);
      } catch (accountingError) {
        console.error("Accounting auto-post failed for credit recovery:", transaction._id, accountingError.message);
      }

      return res.status(200).json({ success: true, transaction });
    }

    if (action === "write-off") {
      const { transactionId, notes } = req.body || {};
      if (!transactionId || !mongoose.Types.ObjectId.isValid(String(transactionId))) {
        return res.status(400).json({ success: false, message: "Valid transaction is required" });
      }

      const transaction = await Transaction.findByIdAndUpdate(
        transactionId,
        {
          creditStatus: "written_off",
          creditNotes: notes || "Written off",
          creditBalance: 0,
        },
        { new: true }
      );

      if (!transaction) {
        return res.status(404).json({ success: false, message: "Credit transaction not found" });
      }

      if (transaction.creditCustomerId) {
        await recalculateCustomerBalance(transaction.creditCustomerId);
      }

      return res.status(200).json({ success: true, transaction });
    }

    if (action === "restore-stock") {
      const { transactionId, returnItems, notes } = req.body || {};
      if (!transactionId || !mongoose.Types.ObjectId.isValid(String(transactionId))) {
        return res.status(400).json({ success: false, message: "Valid transaction is required" });
      }
      if (!Array.isArray(returnItems) || returnItems.length === 0) {
        return res.status(400).json({ success: false, message: "At least one item to return is required" });
      }

      const transaction = await Transaction.findById(transactionId);
      if (!transaction) {
        return res.status(404).json({ success: false, message: "Credit transaction not found" });
      }
      if (["paid", "written_off"].includes(transaction.creditStatus)) {
        return res.status(400).json({ success: false, message: "Cannot restore stock on a settled or written-off credit" });
      }

      // Build a map of original items for validation
      const originalItems = Array.isArray(transaction.items) ? transaction.items : [];
      const alreadyReturned = Array.isArray(transaction.creditReturnedItems) ? transaction.creditReturnedItems : [];

      // Calculate how much of each item has already been returned
      const returnedQtyMap = new Map();
      for (const ri of alreadyReturned) {
        const key = String(ri.productId || ri.name);
        returnedQtyMap.set(key, (returnedQtyMap.get(key) || 0) + Number(ri.qty || 0));
      }

      // Validate and prepare return items
      const validReturns = [];
      let returnValue = 0;

      for (const returnItem of returnItems) {
        const returnQty = Number(returnItem.qty || 0);
        if (returnQty <= 0) continue;

        // Find the matching original item
        const original = originalItems.find((item) => {
          if (returnItem.productId && item.productId) {
            return String(item.productId) === String(returnItem.productId);
          }
          return item.name === returnItem.name;
        });

        if (!original) continue;

        const originalQty = Number(original.qty || original.quantity || 0);
        const key = String(original.productId || original.name);
        const previouslyReturned = returnedQtyMap.get(key) || 0;
        const maxReturnable = originalQty - previouslyReturned;
        const actualReturnQty = Math.min(returnQty, maxReturnable);

        if (actualReturnQty <= 0) continue;

        const unitPrice = Number(original.salePriceIncTax || original.price || 0);
        validReturns.push({
          productId: original.productId || null,
          name: original.name || "Unnamed item",
          qty: actualReturnQty,
          price: unitPrice,
          returnedAt: new Date(),
          returnedBy: req.user?.name || "Admin",
          notes: returnItem.notes || notes || "",
        });
        returnValue += actualReturnQty * unitPrice;
      }

      if (validReturns.length === 0) {
        return res.status(400).json({ success: false, message: "No valid items to return (quantities may already be fully returned)" });
      }

      // Restore stock for items that have productId (real inventory items)
      const stockItems = validReturns.filter((item) => item.productId);
      if (stockItems.length > 0) {
        const mappedItems = stockItems.map((item) => ({
          productId: String(item.productId),
          qty: item.qty,
          revenue: item.qty * item.price,
        }));
        await reverseInventoryForRefund(mappedItems);
      }

      // Record stock movement for audit trail
      if (stockItems.length > 0) {
        const transRef = `CR-RTN-${transaction._id.toString().slice(-6).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
        await StockMovement.create({
          transRef,
          reason: "Restock",
          status: "Received",
          staffId: req.user?._id || null,
          notes: `Credit stock return for ${transaction.creditCustomerName || "credit customer"}. Credit ID: ${transaction._id}. ${notes || ""}`.trim(),
          products: stockItems.map((item) => ({
            productId: item.productId,
            quantity: item.qty,
            costPrice: item.price,
            notes: `Returned from credit - ${item.name}`,
          })),
          totalCostPrice: stockItems.reduce((sum, item) => sum + item.qty * item.price, 0),
          dateSent: new Date(),
          dateReceived: new Date(),
        });
      }

      // Update transaction: reduce balance by returned value, track returned items
      const currentReturnedItems = Array.isArray(transaction.creditReturnedItems) ? transaction.creditReturnedItems : [];
      transaction.creditReturnedItems = [...currentReturnedItems, ...validReturns];

      // Reduce the credit balance and original total by the returned value
      const returnedTotal = toMoney(returnValue);
      const newOriginalTotal = toMoney(Math.max(0, (transaction.creditOriginalTotal || transaction.total || 0) - returnedTotal));
      const paidAmount = getPaymentTotal(transaction);
      const newBalance = Math.max(0, toMoney(newOriginalTotal - paidAmount));

      transaction.creditOriginalTotal = newOriginalTotal;
      transaction.creditBalance = newBalance;
      transaction.creditStatus = getCreditStatus(newBalance, paidAmount, transaction.creditStatus);
      if (transaction.creditStatus === "paid") {
        transaction.creditPaidAt = new Date();
      }
      transaction.creditNotes = `${transaction.creditNotes || ""}\n[Stock Return] ${validReturns.map((i) => `${i.name} x${i.qty}`).join(", ")} restored on ${new Date().toLocaleDateString()}`.trim();

      await transaction.save();

      if (transaction.creditCustomerId) {
        await recalculateCustomerBalance(transaction.creditCustomerId);
      }

      return res.status(200).json({
        success: true,
        message: `${validReturns.length} item(s) restored to stock. Credit reduced by ${returnedTotal.toFixed(2)}.`,
        returnedItems: validReturns,
        newBalance,
        newOriginalTotal,
        transaction,
      });
    }

    return res.status(400).json({ success: false, message: "Unknown credit action" });
  } catch (error) {
    console.error("Credit management API error:", error);
    return res.status(500).json({
      success: false,
      message: "Credit management request failed",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
}