import fs from "fs/promises";
import path from "path";
import PDFDocument from "pdfkit";
import { authMiddleware, isStaff } from "@/lib/auth-middleware";
import { mongooseConnect } from "@/lib/mongodb";
import Store from "@/models/Store";

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

async function resolveFontPath(candidates = []) {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Continue to next candidate.
    }
  }

  return null;
}

async function registerPdfFonts(doc) {
  const regularPath = await resolveFontPath(FONT_CANDIDATES.regular);
  const boldPath = await resolveFontPath(FONT_CANDIDATES.bold);

  if (regularPath) doc.registerFont("AppRegular", regularPath);
  if (boldPath) doc.registerFont("AppBold", boldPath);

  return {
    regular: regularPath ? "AppRegular" : "Helvetica",
    bold: boldPath ? "AppBold" : "Helvetica-Bold",
  };
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

function drawLineField(doc, { label, x, y, width, fonts }) {
  doc
    .font(fonts.bold)
    .fontSize(8)
    .fillColor("#1F2937")
    .text(label, x, y, { width, lineBreak: false });

  const lineY = y + 14;
  doc
    .moveTo(x, lineY)
    .lineTo(x + width, lineY)
    .strokeColor("#94A3B8")
    .lineWidth(0.8)
    .stroke();
}

function drawCustomerFormCard(doc, { x, y, width, height, fonts, companyName, serial }) {
  doc
    .roundedRect(x, y, width, height, 8)
    .strokeColor("#CBD5E1")
    .lineWidth(1)
    .stroke();

  doc
    .font(fonts.bold)
    .fontSize(8.5)
    .fillColor("#0F172A")
    .text(`${companyName} - Customer Intake Form`, x + 10, y + 8, { width: width - 20 });

  doc
    .font(fonts.regular)
    .fontSize(8)
    .fillColor("#64748B")
    .text(`Form #${serial}`, x + width - 64, y + 10, { width: 54, align: "right" });

  drawLineField(doc, { label: "Full Name", x: x + 10, y: y + 26, width: width - 20, fonts });
  drawLineField(doc, { label: "Phone Number", x: x + 10, y: y + 46, width: width - 20, fonts });
  drawLineField(doc, { label: "Email Address", x: x + 10, y: y + 66, width: width - 20, fonts });
  drawLineField(doc, { label: "Address", x: x + 10, y: y + 86, width: width - 20, fonts });
  drawLineField(doc, { label: "Date", x: x + 10, y: y + 106, width: width - 20, fonts });
}

function drawCutGuides(doc, { xPositions, yPositions, cardWidth, cardHeight }) {
  const leftEdge = xPositions[0];
  const rightEdge = xPositions[xPositions.length - 1] + cardWidth;
  const topEdge = yPositions[0];
  const bottomEdge = yPositions[yPositions.length - 1] + cardHeight;

  const verticalCuts = [];
  for (let col = 0; col < xPositions.length - 1; col += 1) {
    const leftCardRightEdge = xPositions[col] + cardWidth;
    const rightCardLeftEdge = xPositions[col + 1];
    verticalCuts.push((leftCardRightEdge + rightCardLeftEdge) / 2);
  }

  const horizontalCuts = [];
  for (let row = 0; row < yPositions.length - 1; row += 1) {
    const upperCardBottom = yPositions[row] + cardHeight;
    const lowerCardTop = yPositions[row + 1];
    horizontalCuts.push((upperCardBottom + lowerCardTop) / 2);
  }

  doc.dash(4, { space: 4 });
  verticalCuts.forEach((x) => {
    doc
      .moveTo(x, topEdge)
      .lineTo(x, bottomEdge)
      .strokeColor("#CBD5E1")
      .lineWidth(0.7)
      .stroke();
  });

  horizontalCuts.forEach((y) => {
    doc
      .moveTo(leftEdge, y)
      .lineTo(rightEdge, y)
      .strokeColor("#CBD5E1")
      .lineWidth(0.7)
      .stroke();
  });
  doc.undash();
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
    const store = await Store.findOne({}).lean();

    const formsPerPage = 8;
    const totalForms = 8;

    const companyName = "St's Michael Warehouse";
    const logoBuffer = await loadLogoBuffer(store?.logo || "");

    const doc = new PDFDocument({ size: "A4", margin: 24 });
    const fonts = await registerPdfFonts(doc);

    const filename = "st-michael-warehouse-customer-blank-forms.pdf";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=\"${filename}\"`);
    doc.pipe(res);

    const cardWidth = 262;
    const cardHeight = 162;
    const xPositions = [34, 300];
    const yPositions = [74, 246, 418, 590];

    for (let index = 0; index < totalForms; index += 1) {
      if (index > 0 && index % formsPerPage === 0) {
        doc.addPage();
      }

      const indexInPage = index % formsPerPage;
      if (indexInPage === 0) {
        if (logoBuffer) {
          try {
            doc.image(logoBuffer, 34, 22, { fit: [32, 32] });
          } catch {
            // Continue without logo.
          }
        }

        doc
          .font(fonts.bold)
          .fontSize(12)
          .fillColor("#0F172A")
          .text(`${companyName} - Walk-In Customer Blank Forms`, 72, 24, { width: 488 });

        doc
          .font(fonts.regular)
          .fontSize(8)
          .fillColor("#475569")
          .text("Print this page and cut on dotted lines to get 8 customer forms.", 72, 40, { width: 488 });

        drawCutGuides(doc, { xPositions, yPositions, cardWidth, cardHeight });
      }

      const column = indexInPage % 2;
      const row = Math.floor(indexInPage / 2);

      drawCustomerFormCard(doc, {
        x: xPositions[column],
        y: yPositions[row],
        width: cardWidth,
        height: cardHeight,
        fonts,
        companyName,
        serial: index + 1,
      });
    }

    doc.end();
  } catch (error) {
    console.error("Customer blank form PDF error:", error);
    if (res.headersSent || res.writableEnded) return;
    return res.status(500).json({ success: false, message: "Unable to generate blank forms" });
  }
}
