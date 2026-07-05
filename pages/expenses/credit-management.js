import Layout from "@/components/Layout";
import Loader from "@/components/Loader";
import { formatCurrency } from "@/lib/format";
import { useEffect, useMemo, useState } from "react";
import { CreditCard, Package, Plus, RefreshCw, RotateCcw, Search, WalletCards, X } from "lucide-react";

function todayKey() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
}

function statusLabel(status) {
  switch (status) {
    case "partly_paid": return "Partly paid";
    case "paid": return "Recovered";
    case "written_off": return "Written off";
    case "open": return "Open";
    default: return "Open";
  }
}

function statusClass(status) {
  switch (status) {
    case "paid": return "bg-emerald-100 text-emerald-800";
    case "partly_paid": return "bg-amber-100 text-amber-800";
    case "written_off": return "bg-gray-100 text-gray-700";
    default: return "bg-blue-100 text-blue-800";
  }
}

export default function CreditManagement() {
  const [data, setData] = useState({ credits: [], customers: [], summary: {} });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState({ type: "", text: "" });
  const [filters, setFilters] = useState({ search: "", status: "" });
  const [customerForm, setCustomerForm] = useState({ name: "", phone: "", email: "", address: "", creditLimit: "", creditNotes: "" });
  const [debtForm, setDebtForm] = useState({ customerId: "", amount: "", dueDate: "", reference: "", notes: "" });
  const [paymentForm, setPaymentForm] = useState({ transactionId: "", amount: "", tenderType: "", reference: "", notes: "", paidAt: todayKey() });
  const [tenders, setTenders] = useState([]);
  const [reviewCredit, setReviewCredit] = useState(null);
  const [returnItems, setReturnItems] = useState([]);
  const [returnNotes, setReturnNotes] = useState("");

  const fetchTenders = async () => {
    try {
      const res = await fetch("/api/setup/tenders");
      if (res.ok) {
        const result = await res.json();
        const list = result.tenders || [];
        setTenders(list);
        if (list.length > 0 && !paymentForm.tenderType) {
          setPaymentForm((prev) => ({ ...prev, tenderType: list[0].name }));
        }
      }
    } catch {}
  };

  const fetchCredits = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/credits");
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.message || "Unable to load credits");
      setData(result);
    } catch (error) {
      console.error("Credit management fetch failed:", error);
      setMessage({ type: "error", text: error.message || "Unable to load credits" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCredits();
    fetchTenders();
  }, []);

  const filteredCredits = useMemo(() => {
    const search = filters.search.trim().toLowerCase();
    return (data.credits || []).filter((credit) => {
      if (filters.status === "active" && ["paid", "written_off"].includes(credit.creditStatus)) return false;
      if (filters.status !== "active" && filters.status && credit.creditStatus !== filters.status) return false;
      if (!search) return true;
      return `${credit.customerName || ""} ${credit.customerPhone || ""} ${credit.location || ""}`.toLowerCase().includes(search);
    });
  }, [data.credits, filters]);

  const postAction = async (payload, successText) => {
    setSaving(true);
    setMessage({ type: "", text: "" });
    try {
      const response = await fetch("/api/credits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.message || "Request failed");
      setMessage({ type: "success", text: successText });
      await fetchCredits();
      return true;
    } catch (error) {
      console.error("Credit action failed:", error);
      setMessage({ type: "error", text: error.message || "Request failed" });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const createCustomer = async (event) => {
    event.preventDefault();
    const ok = await postAction({ action: "create-customer", ...customerForm }, "Credit customer created.");
    if (ok) setCustomerForm({ name: "", phone: "", email: "", address: "", creditLimit: "", creditNotes: "" });
  };

  const createDebt = async (event) => {
    event.preventDefault();
    const ok = await postAction({ action: "create-debt", ...debtForm }, "Credit debt recorded.");
    if (ok) setDebtForm({ customerId: "", amount: "", dueDate: "", reference: "", notes: "" });
  };

  const recordPayment = async (event) => {
    event.preventDefault();
    const ok = await postAction({ action: "record-payment", ...paymentForm }, "Credit payment recorded.");
    if (ok) setPaymentForm({ transactionId: "", amount: "", tenderType: tenders[0]?.name || "", reference: "", notes: "", paidAt: todayKey() });
  };

  const openStockReview = (credit) => {
    setReviewCredit(credit);
    const items = (credit.items || []).map((item) => {
      const originalQty = Number(item.qty || item.quantity || 0);
      // Calculate already-returned qty for this item
      const returned = (credit.creditReturnedItems || [])
        .filter((ri) => (ri.productId && item.productId) ? String(ri.productId) === String(item.productId) : ri.name === item.name)
        .reduce((sum, ri) => sum + Number(ri.qty || 0), 0);
      const maxReturnable = Math.max(0, originalQty - returned);
      return {
        productId: item.productId || null,
        name: item.name || "Unnamed item",
        originalQty,
        returnedQty: returned,
        maxReturnable,
        returnQty: 0,
        price: Number(item.salePriceIncTax || item.price || 0),
      };
    });
    setReturnItems(items);
    setReturnNotes("");
  };

  const closeStockReview = () => {
    setReviewCredit(null);
    setReturnItems([]);
    setReturnNotes("");
  };

  const updateReturnQty = (index, value) => {
    setReturnItems((prev) => prev.map((item, i) =>
      i === index ? { ...item, returnQty: Math.max(0, Math.min(Number(value) || 0, item.maxReturnable)) } : item
    ));
  };

  const returnTotal = useMemo(() => {
    return returnItems.reduce((sum, item) => sum + item.returnQty * item.price, 0);
  }, [returnItems]);

  const processStockReturn = async () => {
    const itemsToReturn = returnItems.filter((item) => item.returnQty > 0);
    if (itemsToReturn.length === 0) {
      setMessage({ type: "error", text: "Select at least one item quantity to return." });
      return;
    }
    const payload = {
      action: "restore-stock",
      transactionId: reviewCredit._id,
      returnItems: itemsToReturn.map((item) => ({
        productId: item.productId,
        name: item.name,
        qty: item.returnQty,
        notes: returnNotes,
      })),
      notes: returnNotes,
    };
    const ok = await postAction(payload, "Stock restored successfully. Credit balance adjusted.");
    if (ok) closeStockReview();
  };

  const selectedCredit = (data.credits || []).find((credit) => credit._id === paymentForm.transactionId);
  const summary = data.summary || {};

  return (
    <Layout>
      <div className="page-container">
        <div className="page-content">
          <div className="page-header">
            <h1 className="page-title">Credit Management</h1>
            <p className="page-subtitle">Track credit customers, outstanding debt, and recovery payments.</p>
          </div>

          {message.text && (
            <div className={`content-card mb-6 border-l-4 ${message.type === "success" ? "border-emerald-500 text-emerald-700" : "border-red-500 text-red-700"}`}>
              {message.text}
            </div>
          )}

          <div className="mb-8 grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
            <div className="content-card border-l-4 border-blue-500 p-5 md:p-6">
              <p className="text-xs font-semibold text-gray-500 uppercase">Credit Customers</p>
              <p className="mt-1 text-2xl font-bold text-gray-900">{summary.creditCustomers || 0}</p>
            </div>
            <div className="content-card border-l-4 border-amber-500 p-5 md:p-6">
              <p className="text-xs font-semibold text-gray-500 uppercase">Outstanding</p>
              <p className="mt-1 text-2xl font-bold text-amber-700">{formatCurrency(summary.outstandingBalance || 0)}</p>
            </div>
            <div className="content-card border-l-4 border-emerald-500 p-5 md:p-6">
              <p className="text-xs font-semibold text-gray-500 uppercase">Recovered</p>
              <p className="mt-1 text-2xl font-bold text-emerald-700">{formatCurrency(summary.totalRecovered || 0)}</p>
            </div>
            <div className="content-card border-l-4 border-purple-500 p-5 md:p-6">
              <p className="text-xs font-semibold text-gray-500 uppercase">Credit Issued</p>
              <p className="mt-1 text-2xl font-bold text-purple-700">{formatCurrency(summary.totalCreditIssued || 0)}</p>
            </div>
          </div>

          <div className="mb-8 grid grid-cols-1 gap-6 xl:grid-cols-3">
            <form onSubmit={createCustomer} className="content-card space-y-4 p-5 md:p-6">
              <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2"><Plus className="w-5 h-5 text-blue-600" /> Create Credit Customer</h2>
              <input required placeholder="Customer name" value={customerForm.name} onChange={(event) => setCustomerForm((prev) => ({ ...prev, name: event.target.value }))} className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
              <input required placeholder="Phone" value={customerForm.phone} onChange={(event) => setCustomerForm((prev) => ({ ...prev, phone: event.target.value }))} className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
              <input type="email" placeholder="Email" value={customerForm.email} onChange={(event) => setCustomerForm((prev) => ({ ...prev, email: event.target.value }))} className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
              <input placeholder="Address" value={customerForm.address} onChange={(event) => setCustomerForm((prev) => ({ ...prev, address: event.target.value }))} className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
              <input type="number" min="0" placeholder="Credit limit" value={customerForm.creditLimit} onChange={(event) => setCustomerForm((prev) => ({ ...prev, creditLimit: event.target.value }))} className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
              <textarea placeholder="Notes" value={customerForm.creditNotes} onChange={(event) => setCustomerForm((prev) => ({ ...prev, creditNotes: event.target.value }))} className="w-full px-3 py-2 border border-gray-300 rounded-lg" rows={3} />
              <button disabled={saving} className="btn-action-primary w-full">Create Customer</button>
            </form>

            <form onSubmit={createDebt} className="content-card space-y-4 p-5 md:p-6">
              <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2"><CreditCard className="w-5 h-5 text-amber-600" /> Record Credit Debt</h2>
              <select required value={debtForm.customerId} onChange={(event) => setDebtForm((prev) => ({ ...prev, customerId: event.target.value }))} className="w-full px-3 py-2 border border-gray-300 rounded-lg">
                <option value="">Select credit customer</option>
                {(data.customers || []).map((customer) => (
                  <option key={customer._id} value={customer._id}>{customer.name} · {customer.phone}</option>
                ))}
              </select>
              <input required type="number" min="1" placeholder="Amount" value={debtForm.amount} onChange={(event) => setDebtForm((prev) => ({ ...prev, amount: event.target.value }))} className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
              <input type="date" value={debtForm.dueDate} onChange={(event) => setDebtForm((prev) => ({ ...prev, dueDate: event.target.value }))} className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
              <input placeholder="Reference" value={debtForm.reference} onChange={(event) => setDebtForm((prev) => ({ ...prev, reference: event.target.value }))} className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
              <textarea placeholder="Notes" value={debtForm.notes} onChange={(event) => setDebtForm((prev) => ({ ...prev, notes: event.target.value }))} className="w-full px-3 py-2 border border-gray-300 rounded-lg" rows={3} />
              <button disabled={saving} className="btn-action-primary w-full">Record Debt</button>
            </form>

            <form onSubmit={recordPayment} className="content-card space-y-4 p-5 md:p-6">
              <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2"><WalletCards className="w-5 h-5 text-emerald-600" /> Record Recovery</h2>
              <select required value={paymentForm.transactionId} onChange={(event) => setPaymentForm((prev) => ({ ...prev, transactionId: event.target.value }))} className="w-full px-3 py-2 border border-gray-300 rounded-lg">
                <option value="">Select open credit</option>
                {(data.credits || []).filter((credit) => !["paid", "written_off"].includes(credit.creditStatus)).map((credit) => (
                  <option key={credit._id} value={credit._id}>{credit.customerName} · Balance {formatCurrency(credit.creditBalance || 0)}</option>
                ))}
              </select>
              {selectedCredit && (
                <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-sm text-emerald-800">
                  Original: {formatCurrency(selectedCredit.creditOriginalTotal || 0)} · Recovered: {formatCurrency(selectedCredit.creditPaidAmount || 0)} · Balance: {formatCurrency(selectedCredit.creditBalance || 0)}
                </div>
              )}
              <input required type="number" min="1" placeholder="Payment amount" value={paymentForm.amount} onChange={(event) => setPaymentForm((prev) => ({ ...prev, amount: event.target.value }))} className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
              <select required value={paymentForm.tenderType} onChange={(event) => setPaymentForm((prev) => ({ ...prev, tenderType: event.target.value }))} className="w-full px-3 py-2 border border-gray-300 rounded-lg">
                <option value="">Select payment type</option>
                {tenders.map((tender) => (
                  <option key={tender._id} value={tender.name}>{tender.name}</option>
                ))}
              </select>
              <input type="date" value={paymentForm.paidAt} onChange={(event) => setPaymentForm((prev) => ({ ...prev, paidAt: event.target.value }))} className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
              <input placeholder="Reference" value={paymentForm.reference} onChange={(event) => setPaymentForm((prev) => ({ ...prev, reference: event.target.value }))} className="w-full px-3 py-2 border border-gray-300 rounded-lg" />
              <textarea placeholder="Notes" value={paymentForm.notes} onChange={(event) => setPaymentForm((prev) => ({ ...prev, notes: event.target.value }))} className="w-full px-3 py-2 border border-gray-300 rounded-lg" rows={2} />
              <button disabled={saving} className="btn-action-primary w-full">Record Payment</button>
            </form>
          </div>

          <div className="content-card p-5 md:p-6">
            <div className="mb-5 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <h2 className="text-lg font-semibold text-gray-900">Credit Recovery Report</h2>
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="relative">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input value={filters.search} onChange={(event) => setFilters((prev) => ({ ...prev, search: event.target.value }))} placeholder="Search customer" className="pl-9 pr-3 py-2 border border-gray-300 rounded-lg" />
                </div>
                <select value={filters.status} onChange={(event) => setFilters((prev) => ({ ...prev, status: event.target.value }))} className="px-3 py-2 border border-gray-300 rounded-lg">
                  <option value="">All</option>
                  <option value="active">Active</option>
                  <option value="open">Open</option>
                  <option value="partly_paid">Partly paid</option>
                  <option value="paid">Recovered</option>
                  <option value="written_off">Written off</option>
                </select>
                <button onClick={fetchCredits} className="btn-action-secondary flex items-center justify-center gap-2"><RefreshCw className="w-4 h-4" /> Refresh</button>
              </div>
            </div>

            {loading ? (
              <Loader text="Loading credit records..." />
            ) : filteredCredits.length === 0 ? (
              <div className="p-6 text-gray-500">No credit records found.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table min-w-[1100px]">
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th>Date</th>
                      <th>Status</th>
                      <th className="text-right">Original</th>
                      <th className="text-right">Recovered</th>
                      <th className="text-right">Balance</th>
                      <th>Payments</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredCredits.map((credit) => (
                      <tr key={credit._id}>
                        <td>
                          <div className="font-semibold text-gray-900">{credit.customerName}</div>
                          <div className="text-xs text-gray-500">{credit.customerPhone || credit.location || "Credit customer"}</div>
                        </td>
                        <td>{credit.createdAt ? new Date(credit.createdAt).toLocaleDateString() : "-"}</td>
                        <td><span className={`px-2 py-1 rounded-full text-xs font-semibold ${statusClass(credit.creditStatus)}`}>{statusLabel(credit.creditStatus)}</span></td>
                        <td className="text-right font-semibold">{formatCurrency(credit.creditOriginalTotal || 0)}</td>
                        <td className="text-right text-emerald-700 font-semibold">{formatCurrency(credit.creditPaidAmount || 0)}</td>
                        <td className="text-right text-amber-700 font-semibold">{formatCurrency(credit.creditBalance || 0)}</td>
                        <td className="text-sm text-gray-600">
                          {credit.creditPayments?.length ? credit.creditPayments.map((payment) => `#${payment.sequence || 1} ${formatCurrency(payment.amount || 0)}`).join(" · ") : "No recovery yet"}
                        </td>
                        <td>
                          {!["paid", "written_off"].includes(credit.creditStatus) && credit.items?.length > 0 && (
                            <button onClick={() => openStockReview(credit)} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors">
                              <Package className="w-3.5 h-3.5" /> Review Stock
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Stock Review & Return Modal */}
          {reviewCredit && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
              <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl bg-white shadow-xl">
                <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between rounded-t-xl">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                      <RotateCcw className="w-5 h-5 text-blue-600" /> Review & Return Stock
                    </h3>
                    <p className="text-sm text-gray-500 mt-0.5">
                      {reviewCredit.customerName} · Balance: {formatCurrency(reviewCredit.creditBalance || 0)}
                    </p>
                  </div>
                  <button onClick={closeStockReview} className="p-2 rounded-lg hover:bg-gray-100 text-gray-500"><X className="w-5 h-5" /></button>
                </div>

                <div className="px-6 py-4 space-y-5">
                  {/* Credit Summary */}
                  <div className="grid grid-cols-3 gap-3">
                    <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 text-center">
                      <p className="text-xs text-blue-600 font-medium">Original</p>
                      <p className="text-sm font-bold text-blue-800">{formatCurrency(reviewCredit.creditOriginalTotal || 0)}</p>
                    </div>
                    <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-center">
                      <p className="text-xs text-emerald-600 font-medium">Paid</p>
                      <p className="text-sm font-bold text-emerald-800">{formatCurrency(reviewCredit.creditPaidAmount || 0)}</p>
                    </div>
                    <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-center">
                      <p className="text-xs text-amber-600 font-medium">Outstanding</p>
                      <p className="text-sm font-bold text-amber-800">{formatCurrency(reviewCredit.creditBalance || 0)}</p>
                    </div>
                  </div>

                  {/* Previously returned items */}
                  {reviewCredit.creditReturnedItems?.length > 0 && (
                    <div className="rounded-lg border border-gray-200 p-4">
                      <h4 className="text-sm font-semibold text-gray-700 mb-2">Previously Returned</h4>
                      <div className="space-y-1">
                        {reviewCredit.creditReturnedItems.map((ri, idx) => (
                          <div key={idx} className="flex justify-between text-xs text-gray-600">
                            <span>{ri.name} × {ri.qty}</span>
                            <span>{formatCurrency(ri.qty * ri.price)} · {new Date(ri.returnedAt).toLocaleDateString()}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Items to return */}
                  <div className="rounded-lg border border-gray-200">
                    <div className="bg-gray-50 px-4 py-3 border-b border-gray-200 rounded-t-lg">
                      <h4 className="text-sm font-semibold text-gray-700">Credit Items — Select Quantities to Return to Stock</h4>
                    </div>
                    <div className="divide-y divide-gray-100">
                      {returnItems.length === 0 ? (
                        <div className="p-4 text-sm text-gray-500">No items with product IDs on this credit entry.</div>
                      ) : (
                        returnItems.map((item, index) => (
                          <div key={index} className="flex items-center gap-3 px-4 py-3">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-gray-900 truncate">{item.name}</p>
                              <p className="text-xs text-gray-500">
                                Orig: {item.originalQty} · Returned: {item.returnedQty} · Available: {item.maxReturnable} · @ {formatCurrency(item.price)}/unit
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              {item.maxReturnable > 0 ? (
                                <>
                                  <input
                                    type="number"
                                    min="0"
                                    max={item.maxReturnable}
                                    value={item.returnQty}
                                    onChange={(e) => updateReturnQty(index, e.target.value)}
                                    className="w-16 px-2 py-1 text-sm border border-gray-300 rounded-lg text-center"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => updateReturnQty(index, item.maxReturnable)}
                                    className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                                  >
                                    All
                                  </button>
                                </>
                              ) : (
                                <span className="text-xs text-gray-400 italic">Fully returned</span>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  {/* Return value summary */}
                  {returnTotal > 0 && (
                    <div className="rounded-lg bg-purple-50 border border-purple-200 p-4">
                      <div className="flex justify-between items-center">
                        <div>
                          <p className="text-sm font-semibold text-purple-800">Stock Return Value</p>
                          <p className="text-xs text-purple-600 mt-0.5">This amount will be deducted from the credit balance</p>
                        </div>
                        <p className="text-lg font-bold text-purple-900">{formatCurrency(returnTotal)}</p>
                      </div>
                    </div>
                  )}

                  {/* Notes */}
                  <textarea
                    placeholder="Return notes (optional)"
                    value={returnNotes}
                    onChange={(e) => setReturnNotes(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    rows={2}
                  />
                </div>

                <div className="sticky bottom-0 bg-white border-t border-gray-200 px-6 py-4 flex justify-end gap-3 rounded-b-xl">
                  <button onClick={closeStockReview} className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200">
                    Cancel
                  </button>
                  <button
                    onClick={processStockReturn}
                    disabled={saving || returnTotal === 0}
                    className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                  >
                    <RotateCcw className="w-4 h-4" />
                    {saving ? "Processing..." : `Restore Stock & Reduce Credit`}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}