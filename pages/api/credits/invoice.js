import fs from "fs/promises";
import path from "path";
import PDFDocument from "pdfkit";
import { mongooseConnect } from "@/lib/mongodb";
import { authMiddleware, isStaff } from "@/lib/auth-middleware";
import Transaction from "@/models/Transactions";
import Store from "@/models/Store";
import Customer from "@/models/Customer";

function toMoney(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function formatCurrency(value, currency = "NGN") {
  try {
    return new Intl.NumberFormat("en-NG", {
      style: "currency",
      currency: currency || "NGN",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(toMoney(value));
  } catch {
    return `NGN ${toMoney(value).toFixed(2)}`;
  }
}

function formatDate(value) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "-";
  return parsed.toLocaleString();
}

function sanitizeFilename(value = "invoice") {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "") || "invoice";
}

async function loadLogoBuffer(logoUrl = "") {
  const trimmed = String(logoUrl || "").trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("data:image/")) {
    const base64Index = trimmed.indexOf("base64,");
    if (base64Index === -1) return null;
    const base64Data = trimmed.slice(base64Index + 7);
    return Buffer.from(base64Data, "base64");
  }

  if (trimmed.startsWith("/")) {
    const localPath = path.join(process.cwd(), "public", trimmed.replace(/^\//, ""));
    try {
      return await fs.readFile(localPath);
    } catch {
      return null;
    }
  }

  if (!/^https?:\/\//i.test(trimmed)) {
    return null;
  }

  try {
    const response = await fetch(trimmed);
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch {
    return null;
  }
}

function getCreditStatusLabel(status) {
  switch (status) {
    case "paid":
      return "Recovered";
    case "partly_paid":
      return "Partly paid";
    case "written_off":
      return "Written off";
    case "open":
      return "Open";
    default:
      return "Open";
  }
}

function drawTableHeader(doc, y) {
  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor("#1E3A8A")
    .text("#", 40, y)
    .text("Item", 68, y)
    .text("Qty", 300, y, { width: 40, align: "right" })
    .text("Unit Price", 355, y, { width: 90, align: "right" })
    .text("Line Total", 455, y, { width: 100, align: "right" });

  doc
    .moveTo(40, y + 15)
    .lineTo(555, y + 15)
    .strokeColor("#BFDBFE")
    .lineWidth(1)
    .stroke();
}

function drawSectionTitle(doc, text, y) {
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor("#0F172A")
    .text(text, 40, y);
}

export default async function handler(req, res) {
  const authError = authMiddleware(req, res);
  if (authError) return authError;

  if (!isStaff(req)) {
    return res.status(403).json({ success: false, message: "Insufficient permissions" });
  }

  if (req.method !== "GET") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  try {
    await mongooseConnect();

    const transactionId = String(req.query?.transactionId || "").trim();
    if (!transactionId) {
      return res.status(400).json({ success: false, message: "transactionId is required" });
    }

    const [transaction, store] = await Promise.all([
      Transaction.findById(transactionId).lean(),
      Store.findOne({}).lean(),
    ]);

    if (!transaction) {
      return res.status(404).json({ success: false, message: "Credit transaction not found" });
    }

    const isCreditRecord =
      transaction.status === "credit"
      || ["open", "partly_paid", "paid", "written_off"].includes(transaction.creditStatus);

    if (!isCreditRecord) {
      return res.status(400).json({ success: false, message: "Invoice is only available for credit records" });
    }

    const customer = transaction.creditCustomerId
      ? await Customer.findById(transaction.creditCustomerId).lean()
      : null;

    const companyName = store?.companyName || store?.companyDisplayName || store?.storeName || "Business";
    const currency = store?.currency || "NGN";
    const items = Array.isArray(transaction.items) ? transaction.items : [];
    const payments = Array.isArray(transaction.creditPayments) ? transaction.creditPayments : [];

    const total = toMoney(transaction.creditOriginalTotal || transaction.total || 0);
    const recovered = toMoney(
      payments.length > 0
        ? payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
        : transaction.creditPaidAmount || 0
    );
    const balance = Math.max(0, toMoney(total - recovered));

    const invoiceCode = `CR-${String(transaction._id).slice(-6).toUpperCase()}`;
    const filename = `${sanitizeFilename(companyName)}-${sanitizeFilename(invoiceCode)}.pdf`;

    const doc = new PDFDocument({ margin: 40, size: "A4" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    doc.pipe(res);

    const logoBuffer = await loadLogoBuffer(store?.logo || "");

    const topY = 40;
    doc
      .rect(40, topY, 515, 95)
      .fill("#F8FAFC")
      .stroke("#E2E8F0");

    if (logoBuffer) {
      try {
        doc.image(logoBuffer, 54, topY + 12, { fit: [64, 64], align: "left" });
      } catch {
        // Continue without logo if the source is unsupported.
      }
    }

    doc
      .font("Helvetica-Bold")
      .fontSize(20)
      .fillColor("#0F172A")
      .text(companyName, 128, topY + 16, { width: 260 });

    const businessMeta = [
      store?.storePhone,
      store?.email,
      store?.website,
    ].filter(Boolean).join(" | ");

    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#334155")
      .text(businessMeta || "", 128, topY + 44, { width: 300 });

    doc
      .font("Helvetica-Bold")
      .fontSize(16)
      .fillColor("#1D4ED8")
      .text("CREDIT INVOICE", 415, topY + 22, { width: 130, align: "right" });

    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#1E293B")
      .text(`Invoice No: ${invoiceCode}`, 355, topY + 53, { width: 190, align: "right" })
      .text(`Issued: ${formatDate(transaction.createdAt)}`, 355, topY + 69, { width: 190, align: "right" });

    let y = 155;
    drawSectionTitle(doc, "Customer Details", y);
    y += 18;

    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#0F172A")
      .text(`Name: ${transaction.creditCustomerName || transaction.customerName || customer?.name || "Credit Customer"}`, 40, y)
      .text(`Phone: ${customer?.phone || "-"}`, 40, y + 16)
      .text(`Email: ${customer?.email || "-"}`, 220, y + 16)
      .text(`Address: ${customer?.address || "-"}`, 40, y + 32, { width: 515 })
      .text(`Status: ${getCreditStatusLabel(transaction.creditStatus)}`, 415, y, { width: 140, align: "right" });

    y += 62;
    drawSectionTitle(doc, "Invoice Items", y);
    y += 16;
    drawTableHeader(doc, y);
    y += 24;

    items.forEach((item, index) => {
      const qty = Number(item.qty || item.quantity || 0);
      const unitPrice = toMoney(item.salePriceIncTax || item.price || 0);
      const lineTotal = toMoney(qty * unitPrice);

      if (y > 680) {
        doc.addPage();
        y = 50;
        drawSectionTitle(doc, "Invoice Items (cont.)", y);
        y += 16;
        drawTableHeader(doc, y);
        y += 24;
      }

      doc
        .font("Helvetica")
        .fontSize(10)
        .fillColor("#0F172A")
        .text(String(index + 1), 40, y)
        .text(String(item.name || "Unnamed item"), 68, y, { width: 220 })
        .text(String(qty), 300, y, { width: 40, align: "right" })
        .text(formatCurrency(unitPrice, currency), 355, y, { width: 90, align: "right" })
        .text(formatCurrency(lineTotal, currency), 455, y, { width: 100, align: "right" });

      y += 20;
    });

    y += 6;
    doc
      .moveTo(320, y)
      .lineTo(555, y)
      .strokeColor("#CBD5E1")
      .lineWidth(1)
      .stroke();

    y += 10;
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#0F172A")
      .text("Original Amount", 355, y, { width: 90, align: "right" })
      .text(formatCurrency(total, currency), 455, y, { width: 100, align: "right" });

    y += 16;
    doc
      .text("Recovered", 355, y, { width: 90, align: "right" })
      .text(formatCurrency(recovered, currency), 455, y, { width: 100, align: "right" });

    y += 16;
    doc
      .font("Helvetica-Bold")
      .fontSize(11)
      .fillColor("#92400E")
      .text("Outstanding", 355, y, { width: 90, align: "right" })
      .text(formatCurrency(balance, currency), 455, y, { width: 100, align: "right" });

    y += 32;
    drawSectionTitle(doc, "Recovery History", y);
    y += 18;

    if (payments.length === 0) {
      doc
        .font("Helvetica")
        .fontSize(10)
        .fillColor("#475569")
        .text("No recovery payment has been recorded for this credit invoice.", 40, y);
      y += 18;
    } else {
      payments.forEach((payment, index) => {
        if (y > 740) {
          doc.addPage();
          y = 50;
          drawSectionTitle(doc, "Recovery History (cont.)", y);
          y += 18;
        }

        doc
          .font("Helvetica")
          .fontSize(10)
          .fillColor("#0F172A")
          .text(`#${payment.sequence || index + 1}`, 40, y)
          .text(formatDate(payment.paidAt), 88, y, { width: 170 })
          .text(payment.tenderType || payment.tenderName || "-", 268, y, { width: 80 })
          .text(payment.reference || "-", 356, y, { width: 110 })
          .text(formatCurrency(payment.amount || 0, currency), 455, y, { width: 100, align: "right" });

        y += 16;
      });
    }

    const noteText = transaction.creditNotes || "";
    if (noteText) {
      y += 14;
      if (y > 730) {
        doc.addPage();
        y = 50;
      }
      drawSectionTitle(doc, "Notes", y);
      y += 18;
      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor("#334155")
        .text(noteText, 40, y, { width: 515 });
    }

    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#64748B")
      .text("Generated by Inventory Admin System", 40, 800, { align: "left" })
      .text(`Generated on ${formatDate(new Date())}`, 40, 800, { align: "right" });

    doc.end();
  } catch (error) {
    console.error("Credit invoice PDF error:", error);
    if (res.headersSent || res.writableEnded) return;
    res.status(500).json({ success: false, message: "Unable to generate invoice" });
  }
}
