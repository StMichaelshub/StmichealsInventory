import mongoose from "mongoose";

const EndOfDayReportSchema = new mongoose.Schema({
  // References
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: "Store", required: true },
  locationId: { type: mongoose.Schema.Types.ObjectId, required: true },
  locationName: { type: String, default: "Unknown" },
  tillId: { type: mongoose.Schema.Types.ObjectId, ref: "Till", required: true },
  
  // Staff Info
  staffId: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
  staffName: String,
  
  // Till Opening Info
  openedAt: Date,
  openingBalance: Number,
  
  // Till Closing Info
  closedAt: { type: Date, default: null },
  closedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" }, // Manager who closed
  
  // Cash Reconciliation
  physicalCount: Number,
  expectedClosingBalance: Number,
  variance: Number,
  variancePercentage: Number,
  
  // Sales Summary
  totalSales: Number,
  transactionCount: Number,
  
  // Tender Breakdown (sales per tender)
  tenderBreakdown: {
    type: Map,
    of: Number,
    default: {},
  },

  // Counted amounts per tender at close (written by the POS)
  tenderActual: {
    type: Map,
    of: Number,
    default: {},
  },

  // Per-tender reconciliation: processed vs counted
  tenderVariances: {
    type: Map,
    of: { processed: Number, counted: Number, variance: Number },
    default: {},
  },
  
  // Additional Info
  closingNotes: String,
  status: { 
    type: String, 
    enum: ["RECONCILED", "VARIANCE_NOTED"], 
    default: "RECONCILED" 
  },
  
  // Metadata
  date: {
    type: Date,
    default: () => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d;
    },
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

EndOfDayReportSchema.index(
  { storeId: 1, locationId: 1, closedAt: 1 },
  { partialFilterExpression: { closedAt: null } }
);

// Avoid re-registering the model in development
const EndOfDayReport = mongoose.models.EndOfDayReport || 
  mongoose.model("EndOfDayReport", EndOfDayReportSchema);

export default EndOfDayReport;
