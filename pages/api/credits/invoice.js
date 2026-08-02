import fs from "fs/promises";
import path from "path";
import PDFDocument from "pdfkit";
import { mongooseConnect } from "@/lib/mongodb";
import { authMiddleware, isStaff } from "@/lib/auth-middleware";
import Transaction from "@/models/Transactions";
import Store from "@/models/Store";
import Customer from "@/models/Customer";

const FONT_CANDIDATES = {
  regular: [
    "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/segoeui.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
  ],
  bold: [
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/segoeuib.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
  ],
};

function toMoney(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function formatCurrency(value, currency = "NGN") {
  const amount = toMoney(value);
  const formatted = amount.toLocaleString("en-NG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency === "NGN" ? formatted : `${currency} ${formatted}`;
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

async function resolveFontPath(candidates = []) {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }

  return null;
}

async function registerPdfFonts(doc) {
  const regularPath = await resolveFontPath(FONT_CANDIDATES.regular);
  const boldPath = await resolveFontPath(FONT_CANDIDATES.bold);

  if (regularPath) {
    doc.registerFont("AppRegular", regularPath);
  }
  if (boldPath) {
    doc.registerFont("AppBold", boldPath);
  }

  return {
    regular: regularPath ? "AppRegular" : "Helvetica",
    bold: boldPath ? "AppBold" : "Helvetica-Bold",
  };
}

function drawNairaAmountRight(doc, {
  amount,
  x,
  y,
  width,
  font,
  fontSize,
  color,
  currency = "NGN",
}) {
  const textValue = formatCurrency(amount, currency);
  doc.font(font).fontSize(fontSize).fillColor(color);

  if (currency !== "NGN") {
    doc.text(textValue, x, y, { width, align: "right" });
    return;
  }

  const rightEdge = x + width;
  const numberWidth = doc.widthOfString(textValue);
  const symbolText = "N";
  const symbolWidth = doc.widthOfString(symbolText);
  const gap = 2;
  const numberX = rightEdge - numberWidth;
  const symbolX = numberX - gap - symbolWidth;

  doc.text(symbolText, symbolX, y, { lineBreak: false });

  const lineYTop = y + (fontSize * 0.52);
  const lineYBottom = y + (fontSize * 0.7);
  doc
    .moveTo(symbolX + 0.5, lineYTop)
    .lineTo(symbolX + symbolWidth - 0.5, lineYTop)
    .strokeColor(color)
    .lineWidth(0.8)
    .stroke();
  doc
    .moveTo(symbolX + 0.5, lineYBottom)
    .lineTo(symbolX + symbolWidth - 0.5, lineYBottom)
    .strokeColor(color)
    .lineWidth(0.8)
    .stroke();

  doc.font(font).fontSize(fontSize).fillColor(color).text(textValue, numberX, y, { lineBreak: false });
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

function drawField(doc, { label, value, x, y, width }) {
  const safeValue = String(value || "-");
  doc
    .font(doc.locals.fonts.bold)
    .fontSize(8)
    .fillColor("#64748B")
    .text(label, x, y, { width, lineBreak: false });

  doc
    .font(doc.locals.fonts.regular)
    .fontSize(10)
    .fillColor("#0F172A")
    .text(safeValue, x, y + 11, { width });

  return y + 11 + doc.heightOfString(safeValue, { width });
}

function ensureSpace(doc, y, heightNeeded, topY = 50) {
  if (y + heightNeeded <= 780) {
    return y;
  }

  doc.addPage();
  return topY;
}

function drawTableHeader(doc, y) {
  doc
    .font(doc.locals.fonts.bold)
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
    .font(doc.locals.fonts.bold)
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

    const companyName = "St's Michael Warehouse";
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
    const fonts = await registerPdfFonts(doc);
    doc.locals = { fonts };

    const logoBuffer = await loadLogoBuffer(store?.logo || "");

    const pageLeft = 36;
    const pageRight = 559;
    const contentWidth = pageRight - pageLeft;
    const topY = 36;
    doc
      .rect(pageLeft, topY, contentWidth, 88)
      .fill("#F8FAFC")
      .stroke("#E2E8F0");

    if (logoBuffer) {
      try {
        doc.image(logoBuffer, pageLeft + 12, topY + 12, { fit: [58, 58], align: "left" });
      } catch {
        // Continue without logo if the source is unsupported.
      }
    }

    const brandX = logoBuffer ? pageLeft + 84 : pageLeft + 16;
    const metaX = 356;

    doc
      .font(fonts.bold)
      .fontSize(20)
      .fillColor("#0F172A")
      .text(companyName, brandX, topY + 14, { width: 250 });

    const businessMeta = [
      store?.storePhone,
      store?.email,
      store?.website,
    ].filter(Boolean).join(" | ");

    doc
      .font(fonts.regular)
      .fontSize(9)
      .fillColor("#334155")
      .text(businessMeta || "", brandX, topY + 42, { width: 250 });

    doc
      .font(fonts.bold)
      .fontSize(16)
      .fillColor("#1D4ED8")
      .text("CREDIT INVOICE", metaX, topY + 18, { width: 180, align: "right" });

    doc
      .font(fonts.regular)
      .fontSize(10)
      .fillColor("#1E293B")
      .text(`Invoice No: ${invoiceCode}`, metaX, topY + 48, { width: 180, align: "right" })
      .text(`Issued: ${formatDate(transaction.createdAt)}`, metaX, topY + 64, { width: 180, align: "right" });

    let y = 142;
    drawSectionTitle(doc, "Customer Details", y);
    y += 14;

    const customerCardY = y;
    const fieldTop = customerCardY + 12;
    const fieldLeftWidth = 235;
    const statusWidth = 95;
    const addressValue = customer?.address || "-";
    const nameBottom = drawField(doc, {
      label: "Customer Name",
      value: transaction.creditCustomerName || transaction.customerName || customer?.name || "Credit Customer",
      x: pageLeft + 12,
      y: fieldTop,
      width: fieldLeftWidth,
    });
    const statusBottom = drawField(doc, {
      label: "Status",
      value: getCreditStatusLabel(transaction.creditStatus),
      x: 464,
      y: fieldTop,
      width: statusWidth,
    });
    const phoneBottom = drawField(doc, {
      label: "Phone",
      value: customer?.phone || "-",
      x: pageLeft + 12,
      y: fieldTop + 32,
      width: 170,
    });
    const emailBottom = drawField(doc, {
      label: "Email",
      value: customer?.email || "-",
      x: 220,
      y: fieldTop + 32,
      width: 220,
    });
    const addressTop = Math.max(phoneBottom, emailBottom) + 8;
    const addressBottom = drawField(doc, {
      label: "Address",
      value: addressValue,
      x: pageLeft + 12,
      y: addressTop,
      width: contentWidth - 24,
    });

    const customerCardHeight = Math.max(addressBottom - customerCardY + 14, 92);
    doc
      .roundedRect(pageLeft, customerCardY, contentWidth, customerCardHeight, 10)
      .fillAndStroke("#FFFFFF", "#E2E8F0");

    drawField(doc, {
      label: "Customer Name",
      value: transaction.creditCustomerName || transaction.customerName || customer?.name || "Credit Customer",
      x: pageLeft + 12,
      y: fieldTop,
      width: fieldLeftWidth,
    });
    drawField(doc, {
      label: "Status",
      value: getCreditStatusLabel(transaction.creditStatus),
      x: 464,
      y: fieldTop,
      width: statusWidth,
    });
    drawField(doc, {
      label: "Phone",
      value: customer?.phone || "-",
      x: pageLeft + 12,
      y: fieldTop + 32,
      width: 170,
    });
    drawField(doc, {
      label: "Email",
      value: customer?.email || "-",
      x: 220,
      y: fieldTop + 32,
      width: 220,
    });
    drawField(doc, {
      label: "Address",
      value: addressValue,
      x: pageLeft + 12,
      y: addressTop,
      width: contentWidth - 24,
    });

    y = Math.max(nameBottom, statusBottom, phoneBottom, emailBottom, addressBottom) + 20;
    drawSectionTitle(doc, "Invoice Items", y);
    y += 16;
    drawTableHeader(doc, y);
    y += 24;

    items.forEach((item, index) => {
      y = ensureSpace(doc, y, 34);
      if (y === 50) {
        drawSectionTitle(doc, "Invoice Items (cont.)", y);
        y += 16;
        drawTableHeader(doc, y);
        y += 24;
      }

      const qty = Number(item.qty || item.quantity || 0);
      const unitPrice = toMoney(item.salePriceIncTax || item.price || 0);
      const lineTotal = toMoney(qty * unitPrice);

      const itemName = String(item.name || "Unnamed item");
      const rowHeight = Math.max(
        18,
        doc.heightOfString(itemName, { width: 220 }),
      );

      doc
        .font(fonts.regular)
        .fontSize(10)
        .fillColor("#0F172A")
        .text(String(index + 1), 40, y)
        .text(itemName, 68, y, { width: 220 })
        .text(String(qty), 300, y, { width: 40, align: "right" })
        .text("", 355, y, { width: 90, align: "right" })
        .text("", 455, y, { width: 100, align: "right" });

      drawNairaAmountRight(doc, {
        amount: unitPrice,
        x: 355,
        y,
        width: 90,
        font: fonts.regular,
        fontSize: 10,
        color: "#0F172A",
        currency,
      });

      drawNairaAmountRight(doc, {
        amount: lineTotal,
        x: 455,
        y,
        width: 100,
        font: fonts.regular,
        fontSize: 10,
        color: "#0F172A",
        currency,
      });

      y += rowHeight + 4;
    });

    y += 2;
    doc
      .moveTo(320, y)
      .lineTo(555, y)
      .strokeColor("#CBD5E1")
      .lineWidth(1)
      .stroke();

    y += 10;
    doc
      .font(fonts.regular)
      .fontSize(10)
      .fillColor("#0F172A")
      .text("Original Amount", 355, y, { width: 90, align: "right" });

    drawNairaAmountRight(doc, {
      amount: total,
      x: 455,
      y,
      width: 100,
      font: fonts.regular,
      fontSize: 10,
      color: "#0F172A",
      currency,
    });

    y += 16;
    doc
      .font(fonts.regular)
      .fontSize(10)
      .fillColor("#0F172A")
      .text("Recovered", 355, y, { width: 90, align: "right" });

    drawNairaAmountRight(doc, {
      amount: recovered,
      x: 455,
      y,
      width: 100,
      font: fonts.regular,
      fontSize: 10,
      color: "#0F172A",
      currency,
    });

    y += 16;
    doc
      .font(fonts.bold)
      .fontSize(11)
      .fillColor("#92400E")
      .text("Outstanding", 355, y, { width: 90, align: "right" });

    drawNairaAmountRight(doc, {
      amount: balance,
      x: 455,
      y,
      width: 100,
      font: fonts.bold,
      fontSize: 11,
      color: "#92400E",
      currency,
    });

    y += 28;
    y = ensureSpace(doc, y, payments.length > 0 ? (payments.length * 18) + 44 : 54);
    drawSectionTitle(doc, "Recovery History", y);
    y += 18;

    if (payments.length === 0) {
      doc
        .font(fonts.regular)
        .fontSize(10)
        .fillColor("#475569")
        .text("No recovery payment has been recorded for this credit invoice.", 40, y);
      y += 18;
    } else {
      payments.forEach((payment, index) => {
        y = ensureSpace(doc, y, 20);
        if (y === 50) {
          drawSectionTitle(doc, "Recovery History (cont.)", y);
          y += 18;
        }

        doc
          .font(fonts.regular)
          .fontSize(10)
          .fillColor("#0F172A")
          .text(`#${payment.sequence || index + 1}`, 40, y)
          .text(formatDate(payment.paidAt), 88, y, { width: 170 })
          .text(payment.tenderType || payment.tenderName || "-", 268, y, { width: 80 })
          .text(payment.reference || "-", 356, y, { width: 110 });

        drawNairaAmountRight(doc, {
          amount: payment.amount || 0,
          x: 455,
          y,
          width: 100,
          font: fonts.regular,
          fontSize: 10,
          color: "#0F172A",
          currency,
        });

        y += 16;
      });
    }

    const noteText = transaction.creditNotes || "";
    if (noteText) {
      y += 12;
      y = ensureSpace(doc, y, 58);
      drawSectionTitle(doc, "Notes", y);
      y += 18;
      doc
        .font(fonts.regular)
        .fontSize(9)
        .fillColor("#334155")
        .text(noteText, 40, y, { width: 515 });
      y += doc.heightOfString(noteText, { width: 515 }) + 8;
    }

    const footerY = Math.min(Math.max(y + 14, 756), 786);
    doc
      .font(fonts.regular)
      .fontSize(9)
      .fillColor("#64748B")
      .text("Generated by Inventory Admin System", 40, footerY, { align: "left" })
      .text(`Generated on ${formatDate(new Date())}`, 40, footerY, { align: "right" });

    doc.end();
  } catch (error) {
    console.error("Credit invoice PDF error:", error);
    if (res.headersSent || res.writableEnded) return;
    res.status(500).json({ success: false, message: "Unable to generate invoice" });
  }
}
