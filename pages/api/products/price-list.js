import fs from "fs/promises";
import path from "path";
import PDFDocument from "pdfkit";
import { authMiddleware, isStaff } from "@/lib/auth-middleware";
import { mongooseConnect } from "@/lib/mongodb";
import Store from "@/models/Store";

const FONT_CANDIDATES = {
  regular: [
    "C:/Windows/Fonts/segoeui.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
  ],
  bold: [
    "C:/Windows/Fonts/segoeuib.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
  ],
};

function sanitizeFilename(value = "price-list") {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "") || "price-list";
}

function formatCurrency(value) {
  const number = Number(value || 0);
  const safeValue = Number.isFinite(number) ? number : 0;
  return safeValue.toLocaleString("en-NG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function toDisplayTitle(value = "") {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/(^|[\s/(-])([a-z])/g, (match, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
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
  let regularName = "Helvetica";
  let boldName = "Helvetica-Bold";

  const regularPath = await resolveFontPath(FONT_CANDIDATES.regular);
  if (regularPath) {
    doc.registerFont("FallbackRegular", regularPath);
    regularName = "FallbackRegular";
  }

  const boldPath = await resolveFontPath(FONT_CANDIDATES.bold);
  if (boldPath) {
    doc.registerFont("FallbackBold", boldPath);
    boldName = "FallbackBold";
  } else if (regularPath) {
    boldName = "FallbackRegular";
  }

  return {
    regular: regularName,
    bold: boldName,
  };
}

function drawNairaVectorSymbol(doc, { x, y, width, height, color }) {
  const scaleX = width / 500;
  const scaleY = height / 600;

  doc.save();
  doc.translate(x, y);
  doc.scale(scaleX, scaleY);
  doc.fillColor(color);

  doc.rect(80, 80, 55, 440).fill();
  doc.rect(365, 80, 55, 440).fill();
  doc.polygon([80, 140], [365, 490], [420, 490], [135, 140]).fill();
  doc.rect(40, 220, 420, 35).fill();
  doc.rect(40, 315, 420, 35).fill();

  doc.restore();
}

function drawNairaAmountRight(doc, {
  amount,
  x,
  y,
  width,
  font,
  fontSize,
  color,
}) {
  const numericText = formatCurrency(amount);
  doc.font(font).fontSize(fontSize).fillColor(color);

  const rightEdge = x + width;
  const numberWidth = doc.widthOfString(numericText);
  const symbolHeight = Math.max(9.5, fontSize * 1.05);
  const symbolWidth = symbolHeight * (500 / 600);
  const gap = 2;
  const numberX = rightEdge - numberWidth;
  const symbolX = numberX - gap - symbolWidth;

  drawNairaVectorSymbol(doc, {
    x: symbolX,
    y: y + (fontSize * 0.04),
    width: symbolWidth,
    height: symbolHeight,
    color,
  });

  doc.text(numericText, numberX, y, { lineBreak: false });
}

async function loadLogoBuffer(logoUrl = "") {
  const trimmed = String(logoUrl || "").trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("data:image/")) {
    const base64Index = trimmed.indexOf("base64,");
    if (base64Index === -1) return null;
    return Buffer.from(trimmed.slice(base64Index + 7), "base64");
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

export default async function handler(req, res) {
  const authError = authMiddleware(req, res);
  if (authError) return authError;

  if (!isStaff(req)) {
    return res.status(403).json({ success: false, message: "Insufficient permissions" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  try {
    await mongooseConnect();

    const title = "Product Price List";
    const products = Array.isArray(req.body?.products) ? req.body.products : [];

    if (products.length === 0) {
      return res.status(400).json({ success: false, message: "No products provided" });
    }

    const store = await Store.findOne({}).lean();
    const companyName = "St's Michael Warehouse";
    const businessMeta = [store?.storePhone, store?.email, store?.website].filter(Boolean).join(" | ");
    const logoBuffer = await loadLogoBuffer(store?.logo || "");

    const filename = `${sanitizeFilename(companyName)}-${sanitizeFilename(title)}.pdf`;

    const doc = new PDFDocument({ margin: 36, size: "A4" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    doc.pipe(res);
    const fonts = await registerPdfFonts(doc);

    doc
      .rect(36, 36, 523, 82)
      .fill("#F8FAFC")
      .stroke("#E2E8F0");

    if (logoBuffer) {
      try {
        doc.image(logoBuffer, 48, 48, { fit: [54, 54], align: "left" });
      } catch {
        // Ignore bad image sources and continue without a logo.
      }
    }

    doc
      .font(fonts.bold)
      .fontSize(20)
      .fillColor("#0F172A")
      .text(companyName, 118, 50, { width: 320 });

    doc
      .font(fonts.regular)
      .fontSize(9)
      .fillColor("#475569")
      .text(businessMeta, 118, 76, { width: 280 });

    doc
      .font(fonts.bold)
      .fontSize(16)
      .fillColor("#1D4ED8")
      .text(title, 360, 61, { width: 180, align: "right" });

    let y = 138;

    doc
      .font(fonts.bold)
      .fontSize(10)
      .fillColor("#1E3A8A")
      .text("#", 40, y)
      .text("Product", 75, y)
      .text("Price", 420, y, { width: 120, align: "right" });

    doc
      .moveTo(40, y + 14)
      .lineTo(555, y + 14)
      .strokeColor("#BFDBFE")
      .lineWidth(1)
      .stroke();

    y += 24;

    products.forEach((product, index) => {
      const productName = toDisplayTitle(product.name || "");
      const priceValue = Number(product.salePriceIncTax || 0);

      const rowHeight = Math.max(
        doc.heightOfString(productName, { width: 320 }),
        14
      );

      if (y + rowHeight > 770) {
        doc.addPage();
        y = 48;
        doc
          .font(fonts.bold)
          .fontSize(10)
          .fillColor("#1E3A8A")
          .text("#", 40, y)
          .text("Product", 75, y)
          .text("Price", 420, y, { width: 120, align: "right" });
        doc
          .moveTo(40, y + 14)
          .lineTo(555, y + 14)
          .strokeColor("#BFDBFE")
          .lineWidth(1)
          .stroke();
        y += 24;
      }

      doc
        .font(fonts.regular)
        .fontSize(9.5)
        .fillColor("#0F172A")
        .text(String(index + 1), 40, y)
        .text(productName, 75, y, { width: 320 });

      drawNairaAmountRight(doc, {
        amount: priceValue,
        x: 420,
        y,
        width: 120,
        font: fonts.regular,
        fontSize: 9.5,
        color: "#0F172A",
      });

      y += rowHeight + 8;

      doc
        .moveTo(40, y - 4)
        .lineTo(555, y - 4)
        .strokeColor("#E2E8F0")
        .lineWidth(0.5)
        .stroke();
    });

    doc
      .font(fonts.regular)
      .fontSize(9)
      .fillColor("#64748B")
      .text(`Total products: ${products.length}`, 40, Math.min(y + 8, 788));

    doc.end();
  } catch (error) {
    console.error("Product price list PDF error:", error);
    if (res.headersSent || res.writableEnded) return;
    return res.status(500).json({ success: false, message: "Unable to generate price list PDF" });
  }
}
