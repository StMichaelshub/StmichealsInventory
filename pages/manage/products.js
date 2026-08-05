// pages/manage/products.js  (or your route file)
"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Printer, Search } from "lucide-react";
import Layout from "@/components/Layout";
import { formatCurrency as formatCurrencyValue } from "@/lib/format";
import axios from "axios";
import Link from "next/link";
import { useRouter } from "next/router";
import { mutate } from "swr";
import { useIndexedDBCache, clearCache } from "@/lib/useIndexedDBCache";
import { getCachedCategories } from "@/lib/categoriesCache";
import { calculateMarginPercent } from "@/lib/pricing";
import { apiClient } from "@/lib/api-client";
import { showAlertDialog, showConfirmDialog } from "@/lib/dialogs";
import { Loader } from "@/components/ui";

const entriesPerPageDefault = 20;
const entriesPerPageOptions = [10, 20, 50, 100];

function getStoredPositiveInteger(key, fallback) {
  if (typeof window === "undefined") return fallback;
  const parsedValue = Number.parseInt(window.sessionStorage.getItem(key) || "", 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
}

function clampPage(page, totalPages) {
  const normalizedPage = Number.parseInt(page, 10);
  const safePage = Number.isFinite(normalizedPage) ? normalizedPage : 1;
  return Math.min(Math.max(1, safePage), Math.max(1, totalPages));
}

function getPaginationPages(currentPage, totalPages) {
  const pageWindowSize = 5;
  const pages = [];
  const safeTotalPages = Math.max(1, totalPages);
  let startPage = Math.max(1, currentPage - Math.floor(pageWindowSize / 2));
  let endPage = Math.min(safeTotalPages, startPage + pageWindowSize - 1);

  startPage = Math.max(1, endPage - pageWindowSize + 1);

  for (let page = startPage; page <= endPage; page += 1) {
    pages.push(page);
  }

  return pages;
}

// --- fetcher for SWR (uses axios so your existing endpoints stay the same)
const fetcher = (url) => axios.get(url).then((r) => r.data);

// Debounce utility
function debounce(func, wait) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

function formatPropertiesForInput(properties = []) {
  return (Array.isArray(properties) ? properties : [])
    .map((property) => {
      const propName = property?.propName ?? property?.name ?? "";
      const propValue = property?.propValue ?? property?.value ?? "";
      return propValue ? `${propName}: ${propValue}` : propName;
    })
    .filter(Boolean)
    .join("\n");
}

function parsePropertiesInput(value = "") {
  return String(value)
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separatorIndex = entry.indexOf(":");
      if (separatorIndex === -1) {
        return { propName: entry, propValue: "" };
      }

      return {
        propName: entry.slice(0, separatorIndex).trim(),
        propValue: entry.slice(separatorIndex + 1).trim(),
      };
    })
    .filter((property) => property.propName);
}

function normalizeLocationValue(value) {
  return String(value || "").trim().toLowerCase();
}

export default function Products() {
  const router = useRouter();
  const fetchProducts = useCallback(() => fetcher("/api/products"), []);
  const queryLocation = typeof router.query.location === "string" ? router.query.location : "";

  // ========== SMART CACHING STRATEGY ==========
  // Products: IndexedDB cache with 30-minute TTL (frequently changes)
  // + SWR background revalidation (only if cache expired)
  const { data: cachedProducts, loading: productsLoading, error: productsError, refresh: refreshProducts } = useIndexedDBCache(
    "products_cache",
    fetchProducts,
    30 // 30 minutes TTL
  );

  // ========== LOCAL UI STATE ==========
  const [allProducts, setAllProducts] = useState([]); // full list (from cache)
  const [filteredProducts, setFilteredProducts] = useState([]); // after search/filter
  const [categoryMap, setCategoryMap] = useState({});
  const [editIndex, setEditIndex] = useState(null);
  const [editableProduct, setEditableProduct] = useState({});
  const [propertiesText, setPropertiesText] = useState("");
  const [searchTerm, setSearchTerm] = useState(
    typeof window !== "undefined" ? sessionStorage.getItem("products:searchTerm") || "" : ""
  );
  const [expandedRow, setExpandedRow] = useState(null);
  const [isInitializing, setIsInitializing] = useState(true); // Track first load
  const [isRefreshingList, setIsRefreshingList] = useState(false);
  const [isApplyingChanges, setIsApplyingChanges] = useState(false);
  const [savingProductId, setSavingProductId] = useState(null);
  const [isOpeningAddProduct, setIsOpeningAddProduct] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState(
    typeof window !== "undefined" ? sessionStorage.getItem("products:categoryFilter") || "all" : "all"
  );
  const [selectedLocation, setSelectedLocation] = useState(
    typeof window !== "undefined"
      ? sessionStorage.getItem("products:locationFilter") || queryLocation || "all"
      : queryLocation || "all"
  );
  const [availableLocations, setAvailableLocations] = useState([]);
  const [selectedProductIds, setSelectedProductIds] = useState([]);
  const [showPriceListModal, setShowPriceListModal] = useState(false);
  const [priceListMode, setPriceListMode] = useState("all");
  const [priceListCategories, setPriceListCategories] = useState([]);
  const [priceListExcludeUnitProducts, setPriceListExcludeUnitProducts] = useState(false);
  const [isPrintingPriceList, setIsPrintingPriceList] = useState(false);

  // pagination
  const [entriesPerPage, setEntriesPerPage] = useState(() => {
    const storedPageSize = getStoredPositiveInteger("products:entriesPerPage", entriesPerPageDefault);
    return entriesPerPageOptions.includes(storedPageSize) ? storedPageSize : entriesPerPageDefault;
  });
  const [currentPage, setCurrentPage] = useState(() => getStoredPositiveInteger("products:currentPage", 1));

  // highlighted product id (persisted so when you go to edit page and back it stays)
  const [highlightedId, setHighlightedId] = useState(
    typeof window !== "undefined" ? sessionStorage.getItem("products:highlight") : null
  );

  // refs
  const searchRef = useRef();

  const categoryOptions = useMemo(() => {
    const seen = new Set();
    const rows = [];
    (Array.isArray(allProducts) ? allProducts : []).forEach((p) => {
      const id = p?.category;
      if (!id || seen.has(id)) return;
      seen.add(id);
      rows.push({ id, label: categoryMap[id] || "Uncategorized" });
    });
    return rows.sort((a, b) => a.label.localeCompare(b.label));
  }, [allProducts, categoryMap]);

  const allCategoryOptions = useMemo(
    () => Object.entries(categoryMap)
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    [categoryMap]
  );

  const locationOptions = useMemo(() => {
    const seenLocations = new Map();

    [...availableLocations, ...(Array.isArray(allProducts) ? allProducts.flatMap((product) => product.locations || []) : [])]
      .map((locationValue) => String(locationValue || "").trim())
      .filter(Boolean)
      .forEach((locationValue) => {
        const normalizedValue = normalizeLocationValue(locationValue);
        if (!seenLocations.has(normalizedValue)) {
          seenLocations.set(normalizedValue, locationValue);
        }
      });

    return Array.from(seenLocations.values()).sort((leftValue, rightValue) => leftValue.localeCompare(rightValue));
  }, [availableLocations, allProducts]);

  const applyFilters = useCallback((term, categoryId, locationId) => {
    const t = term.trim().toLowerCase();
    const filtered = (Array.isArray(allProducts) ? allProducts : []).filter((p) => {
      const matchesCategory = categoryId === "all" ? true : p.category === categoryId;
      if (!matchesCategory) return false;

      const normalizedLocationFilter = normalizeLocationValue(locationId);
      const productLocations = Array.isArray(p.locations)
        ? p.locations.map((locationValue) => normalizeLocationValue(locationValue)).filter(Boolean)
        : [];
      const matchesLocation =
        normalizedLocationFilter === "all"
          ? true
          : normalizedLocationFilter === "unassigned"
            ? productLocations.length === 0
            : productLocations.includes(normalizedLocationFilter);
      if (!matchesLocation) return false;

      if (!t) return true;
      return [p.name, p.barcode, p.description, categoryMap[p.category]]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(t));
    });
    setFilteredProducts(filtered);
  }, [allProducts, categoryMap]);

  // Initialize from cache when data arrives
  useEffect(() => {
    if (productsLoading) {
      setIsInitializing(true);
      return;
    }
    const list = Array.isArray(cachedProducts) ? cachedProducts : cachedProducts?.data || [];
    setAllProducts(list);
    const t = searchTerm.trim().toLowerCase();
    const filtered = list.filter((p) => {
      const matchesCategory = selectedCategory === "all" ? true : p.category === selectedCategory;
      if (!matchesCategory) return false;

      const normalizedLocationFilter = normalizeLocationValue(selectedLocation);
      const productLocations = Array.isArray(p.locations)
        ? p.locations.map((locationValue) => normalizeLocationValue(locationValue)).filter(Boolean)
        : [];
      const matchesLocation =
        normalizedLocationFilter === "all"
          ? true
          : normalizedLocationFilter === "unassigned"
            ? productLocations.length === 0
            : productLocations.includes(normalizedLocationFilter);
      if (!matchesLocation) return false;

      if (!t) return true;
      return [p.name, p.barcode, p.description, categoryMap[p.category]]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(t));
    });
    setFilteredProducts(filtered);
    setIsInitializing(false);
  }, [cachedProducts, productsLoading, searchTerm, selectedCategory, selectedLocation, categoryMap]);

  const loadCategories = useCallback(async () => {
    try {
      const catList = await getCachedCategories();
      const map = (Array.isArray(catList) ? catList : []).reduce((acc, c) => {
        acc[c._id] = c.name;
        return acc;
      }, {});
      setCategoryMap(map);
    } catch {
      setCategoryMap({});
    }
  }, []);

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  useEffect(() => {
    let isMounted = true;

    apiClient.get("/api/setup/get")
      .then((response) => {
        if (!isMounted) {
          return;
        }

        const storeLocations = Array.isArray(response.data?.store?.locations)
          ? response.data.store.locations
              .map((locationValue) => locationValue?.name || locationValue)
              .map((locationValue) => String(locationValue || "").trim())
              .filter(Boolean)
          : [];

        setAvailableLocations(storeLocations);
      })
      .catch(() => {});

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    const onFocus = () => loadCategories();
    const onStorage = (event) => {
      if (event.key === "categories_cache_version") {
        loadCategories();
      }
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("storage", onStorage);
    };
  }, [loadCategories]);

  // Keep highlightedId in sessionStorage so it's preserved when navigating away & back
  useEffect(() => {
    if (highlightedId) sessionStorage.setItem("products:highlight", highlightedId);
    else sessionStorage.removeItem("products:highlight");
  }, [highlightedId]);

  // Persist list filters so returning from advanced edit keeps current view.
  useEffect(() => {
    if (typeof window === "undefined") return;
    sessionStorage.setItem("products:searchTerm", searchTerm || "");
  }, [searchTerm]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    sessionStorage.setItem("products:categoryFilter", selectedCategory || "all");
  }, [selectedCategory]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    sessionStorage.setItem("products:locationFilter", selectedLocation || "all");
  }, [selectedLocation]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    sessionStorage.setItem("products:currentPage", String(currentPage));
  }, [currentPage]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    sessionStorage.setItem("products:entriesPerPage", String(entriesPerPage));
  }, [entriesPerPage]);

  useEffect(() => {
    if (!queryLocation) return;
    setSelectedLocation(queryLocation);
    setCurrentPage(1);
    applyFilters(searchTerm, selectedCategory, queryLocation);
  }, [queryLocation, applyFilters, searchTerm, selectedCategory]);

  // Warm the add-product route bundle to make navigation faster.
  useEffect(() => {
    router.prefetch("/products/new");
  }, [router]);

  // Force refresh after add/edit flow redirects back to this page
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (sessionStorage.getItem("products:refresh") !== "1") return;

    sessionStorage.removeItem("products:refresh");
    (async () => {
      try {
        setIsApplyingChanges(true);
        await clearCache("products_cache");
        await refreshProducts();
        mutate("/api/products");
        await loadCategories();
      } finally {
        setIsApplyingChanges(false);
      }
    })();
  }, [refreshProducts, loadCategories]);

  // Debounced search over the cached allProducts (safe - products array guarded)
  const debouncedFilter = useCallback(
    debounce((term) => {
      applyFilters(term, selectedCategory, selectedLocation);
    }, 250),
    [applyFilters, selectedCategory, selectedLocation]
  );

  const handleSearchChange = (e) => {
    const v = e.target.value;
    setSearchTerm(v);
    setCurrentPage(1);
    debouncedFilter(v);
  };

  const handleCategoryFilterChange = (e) => {
    const value = e.target.value;
    setSelectedCategory(value);
    setCurrentPage(1);
    applyFilters(searchTerm, value, selectedLocation);
  };

  const handleLocationFilterChange = (e) => {
    const value = e.target.value;
    setSelectedLocation(value);
    setCurrentPage(1);
    applyFilters(searchTerm, selectedCategory, value);
  };

  // Inline edit handlers
  const handleEditClick = (index, product) => {
    setEditIndex(index);
    setEditableProduct({ ...product });
    setPropertiesText(formatPropertiesForInput(product.properties || []));
    // set highlight now so when user leaves/returns it remains
    setHighlightedId(product._id);
  };

  const handleCancelClick = () => {
    setEditIndex(null);
    setEditableProduct({});
    setPropertiesText("");
    // keep highlight (helpful)  comment out to clear highlight on cancel
    // setHighlightedId(null);
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setEditableProduct((prev) => {
      const newValue = type === "checkbox" ? checked : value;
      const updated = { ...prev, [name]: newValue };
      const cost = parseFloat(updated.costPrice || 0);
      const margin = parseFloat(updated.margin || 0);
      const tax = parseFloat(updated.taxRate || 0);
      const sale = parseFloat(updated.salePriceIncTax || 0);

      if (name === "margin") {
        const marginRatio = margin / 100;
        const saleExTax = cost * (1 + marginRatio);
        const saleIncTax = saleExTax * (1 + tax / 100);
        updated.salePriceIncTax = Number.isFinite(saleIncTax) ? saleIncTax.toFixed(2) : "0.00";
      }
      if (["costPrice", "taxRate", "salePriceIncTax"].includes(name)) {
        updated.margin = calculateMarginPercent(cost, sale, tax, true).toFixed(2);
      }
      return updated;
    });
  };

  const handleUpdateClick = async (_id) => {
    try {
      setSavingProductId(_id);
      const updatedProduct = {
        ...editableProduct,
        properties: parsePropertiesInput(propertiesText),
      };
      const response = await axios.put("/api/products", { ...updatedProduct, _id });
      const saved = response?.data?.data || { ...updatedProduct, _id };

      // update local cached arrays immediately (optimistic update)
      setFilteredProducts((prev) =>
        prev.map((p) => (p._id === _id ? { ...p, ...saved } : p))
      );
      setAllProducts((prev) => prev.map((p) => (p._id === _id ? { ...p, ...saved } : p)));

      // close edit mode & highlight the updated product
      setEditIndex(null);
      setHighlightedId(_id);
      const indexInFiltered = (filteredProducts || []).findIndex((p) => p._id === _id);
      if (indexInFiltered >= 0) {
        setCurrentPage(Math.floor(indexInFiltered / entriesPerPage) + 1);
      }
    } catch (err) {
      console.error("Failed to update product", err);
      await showAlertDialog({
        title: "Update failed",
        message: "Failed to update product.",
        tone: "danger",
      });
    } finally {
      setSavingProductId(null);
    }
  };

  const handleDeleteClick = async (_id) => {
    const shouldArchive = await showConfirmDialog({
      title: "Archive product?",
      message: "The product will move to the archived list.",
      tone: "warning",
      confirmLabel: "Archive product",
      cancelLabel: "Keep product",
    });
    if (!shouldArchive) return;
    try {
      await axios.delete(`/api/products?id=${_id}`);
      setFilteredProducts((prev) => prev.filter((p) => p._id !== _id));
      setAllProducts((prev) => prev.filter((p) => p._id !== _id));
      
      // Invalidate cache and refresh
      await clearCache("products_cache");
      await refreshProducts();
      
      mutate("/api/products");
      await loadCategories();
      if (highlightedId === _id) setHighlightedId(null);
      await showAlertDialog({
        title: "Product archived",
        message: "The product was moved to the archived list.",
        tone: "success",
      });
    } catch (err) {
      console.error("delete failed", err);
      await showAlertDialog({
        title: "Archive failed",
        message: "The product could not be archived.",
        tone: "danger",
      });
    }
  };

  const formatCurrency = (num) => formatCurrencyValue(num || 0);

  const totalFilteredProducts = Array.isArray(filteredProducts) ? filteredProducts.length : 0;
  const totalPages = Math.max(1, Math.ceil(totalFilteredProducts / entriesPerPage));
  const safeCurrentPage = clampPage(currentPage, totalPages);
  const pageStartIndex = totalFilteredProducts === 0 ? 0 : (safeCurrentPage - 1) * entriesPerPage;
  const pageEndIndex = Math.min(totalFilteredProducts, pageStartIndex + entriesPerPage);
  const visibleProducts = Array.isArray(filteredProducts)
    ? filteredProducts.slice(pageStartIndex, pageEndIndex)
    : [];
  const paginationPages = getPaginationPages(safeCurrentPage, totalPages);

  const goToPage = useCallback((pageNumber) => {
    setCurrentPage(clampPage(pageNumber, totalPages));
    setExpandedRow(null);
  }, [totalPages]);

  const handleEntriesPerPageChange = (e) => {
    const nextEntriesPerPage = Number.parseInt(e.target.value, 10) || entriesPerPageDefault;
    const firstVisibleItem = pageStartIndex + 1;
    const nextPage = Math.max(1, Math.ceil(firstVisibleItem / nextEntriesPerPage));

    setEntriesPerPage(nextEntriesPerPage);
    setCurrentPage(nextPage);
    setExpandedRow(null);
  };

  const rememberListPosition = useCallback(() => {
    if (typeof window === "undefined") return;
    sessionStorage.setItem("products:currentPage", String(safeCurrentPage));
    sessionStorage.setItem("products:scrollY", String(window.scrollY || 0));
  }, [safeCurrentPage]);

  useEffect(() => {
    if (typeof window === "undefined" || isInitializing || isApplyingChanges) return;

    const storedScrollY = sessionStorage.getItem("products:scrollY");
    if (!storedScrollY) return;

    sessionStorage.removeItem("products:scrollY");
    const scrollY = Number.parseInt(storedScrollY, 10);
    if (!Number.isFinite(scrollY) || scrollY < 0) return;

    window.requestAnimationFrame(() => {
      window.scrollTo({ top: scrollY, behavior: "auto" });
    });
  }, [isApplyingChanges, isInitializing, visibleProducts.length]);

  const paginationButtonClass =
    "min-w-[2.5rem] rounded-md border border-gray-200 px-3 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50";
  const activePaginationButtonClass =
    "min-w-[2.5rem] rounded-md border border-blue-600 bg-blue-600 px-3 py-2 text-sm font-semibold text-white";

  const renderPageButton = (pageNumber) => {
    const isActive = pageNumber === safeCurrentPage;

    return (
      <button
        key={pageNumber}
        type="button"
        onClick={() => goToPage(pageNumber)}
        aria-current={isActive ? "page" : undefined}
        className={isActive ? activePaginationButtonClass : paginationButtonClass}
      >
        {pageNumber}
      </button>
    );
  };

  const allVisibleSelected = visibleProducts.length > 0
    && visibleProducts.every((product) => selectedProductIds.includes(product._id));

  const toggleProductSelection = useCallback((productId) => {
    setSelectedProductIds((prev) => {
      if (prev.includes(productId)) {
        return prev.filter((id) => id !== productId);
      }
      return [...prev, productId];
    });
  }, []);

  const toggleSelectVisibleProducts = useCallback(() => {
    const visibleIds = visibleProducts.map((product) => product._id);
    setSelectedProductIds((prev) => {
      const visibleSet = new Set(visibleIds);
      const allSelected = visibleIds.length > 0 && visibleIds.every((id) => prev.includes(id));
      if (allSelected) {
        return prev.filter((id) => !visibleSet.has(id));
      }

      const merged = new Set(prev);
      visibleIds.forEach((id) => merged.add(id));
      return Array.from(merged);
    });
  }, [visibleProducts]);

  const openPriceListModal = () => {
    setPriceListMode(selectedProductIds.length > 0 ? "selected" : "all");
    setPriceListCategories(selectedCategory !== "all" ? [selectedCategory] : []);
    setPriceListExcludeUnitProducts(false);
    setShowPriceListModal(true);
  };

  const closePriceListModal = () => {
    setShowPriceListModal(false);
  };

  const getPriceListProducts = () => {
    let products;
    if (priceListMode === "selected") {
      const selectedIds = new Set(selectedProductIds);
      products = allProducts.filter((product) => selectedIds.has(product._id));
    } else if (priceListMode === "filtered") {
      products = filteredProducts;
    } else if (priceListMode === "category") {
      if (priceListCategories.length === 0) {
        products = allProducts;
      } else {
        const categorySet = new Set(priceListCategories);
        products = allProducts.filter((product) => categorySet.has(product.category));
      }
    } else {
      products = allProducts;
    }

    if (priceListExcludeUnitProducts) {
      products = products.filter((product) => !product.isChildProduct);
    }

    return products;
  };

  const handlePrintPriceList = async () => {
    const rows = getPriceListProducts()
      .slice()
      .sort((left, right) => String(left.name || "").localeCompare(String(right.name || "")));

    if (rows.length === 0) {
      await showAlertDialog({
        title: "No products to print",
        message: "Adjust your selection or filters, then try again.",
        tone: "warning",
      });
      return;
    }

    setIsPrintingPriceList(true);
    try {
      const categoryTitle = priceListCategories.length > 0
        ? priceListCategories.map((id) => categoryMap[id] || "Uncategorized").join(", ")
        : "All";
      const titleByMode = {
        all: "General Product Price List",
        filtered: "Filtered Product Price List",
        selected: "Selected Product Price List",
        category: `Category Price List - ${categoryTitle}`,
      };
      const reportTitle = titleByMode[priceListMode] || "Product Price List";
      const response = await fetch("/api/products/price-list", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: reportTitle,
          products: rows.map((product) => ({
            name: product.name || "",
            barcode: product.barcode || "",
            locations: Array.isArray(product.locations) && product.locations.length > 0
              ? product.locations.join(", ")
              : "Unassigned",
            categoryLabel: categoryMap[product.category] || product.category || "Uncategorized",
            salePriceIncTax: Number(product.salePriceIncTax || 0),
          })),
        }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || "Unable to generate price list PDF");
      }

      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") || "";
      const filenameMatch = disposition.match(/filename=\"?([^\";]+)\"?/i);
      const filename = filenameMatch?.[1] || "product-price-list.pdf";
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);

      closePriceListModal();
    } catch (error) {
      console.error("Price list download failed", error);
      await showAlertDialog({
        title: "Download failed",
        message: error.message || "Unable to generate price list PDF.",
        tone: "danger",
      });
    } finally {
      setIsPrintingPriceList(false);
    }
  };

  if (productsError) {
    return (
      <Layout>
        <div className="p-6">
          <h2 className="text-xl text-red-600">Failed to load products</h2>
          <p className="text-sm text-gray-600">{String(productsError)}</p>
          <button 
            onClick={() => refreshProducts()}
            className="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Try Again
          </button>
        </div>
      </Layout>
    );
  }

  // Show initial loading state
  if (isInitializing || isApplyingChanges) {
    return (
      <Layout>
        <div className="p-6 text-center">
          <Loader size="md" text={isApplyingChanges ? "Applying latest changes..." : "Loading products..."} />
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="page-container">
        <div className="page-content">
        {/* Header */}
        <div className="page-header flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <h1 className="page-title">Products</h1>
          <div className="flex gap-2 flex-wrap">
            <button
              type="button"
              onClick={openPriceListModal}
              className="btn-action-secondary flex items-center gap-2"
            >
              <Printer size={16} /> Print Price List
            </button>
            <button
              onClick={async () => {
                try {
                  setIsRefreshingList(true);
                  await refreshProducts();
                  await loadCategories();
                } finally {
                  setIsRefreshingList(false);
                }
              }}
              className="btn-action-secondary flex items-center gap-2"
              title="Refresh products from server"
              disabled={isRefreshingList}
            >
               {isRefreshingList ? "Refreshing..." : "Refresh"}
            </button>
            <button
              type="button"
              onClick={() => {
                setIsOpeningAddProduct(true);
                router.push("/products/new");
              }}
              disabled={isOpeningAddProduct}
              className="btn-action-primary w-full sm:w-auto text-center disabled:opacity-60"
            >
              {isOpeningAddProduct ? "Opening..." : "+ Add Product"}
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="mb-6">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="search-input-wrapper max-w-lg flex-1">
              <Search className="search-input-icon" />
              <input
                ref={searchRef}
                type="text"
                placeholder="Search products..."
                className="search-input"
                value={searchTerm}
                onChange={handleSearchChange}
              />
            </div>
            <select
              className="form-select max-w-xs"
              value={selectedCategory}
              onChange={handleCategoryFilterChange}
            >
              <option value="all">All Categories</option>
              {categoryOptions.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.label}
                </option>
              ))}
            </select>
            <select
              className="form-select max-w-xs"
              value={selectedLocation}
              onChange={handleLocationFilterChange}
            >
              <option value="all">All Locations</option>
              <option value="unassigned">Unassigned</option>
              {locationOptions.map((locationValue) => (
                <option key={locationValue} value={locationValue}>
                  {locationValue}
                </option>
              ))}
            </select>
              <div className="flex items-center gap-2 sm:ml-2">
                <button
                  type="button"
                  onClick={toggleSelectVisibleProducts}
                  className="btn-action-secondary !px-3 !py-2 text-xs"
                >
                  {allVisibleSelected ? "Unselect Page" : "Select Page"}
                </button>
                {selectedProductIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelectedProductIds([])}
                    className="btn-action-secondary !px-3 !py-2 text-xs"
                  >
                    Clear Selection ({selectedProductIds.length})
                  </button>
                )}
              </div>
          </div>
        </div>

        {/* Table - Responsive wrapper */}
        <div className="data-table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th className="!px-2"></th>
                <th className="!px-2">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={(event) => {
                      event.stopPropagation();
                      toggleSelectVisibleProducts();
                    }}
                    aria-label="Select visible products"
                  />
                </th>
                <th className="!px-2">Adv</th>
                <th>Name</th>
                <th className="hidden sm:table-cell">Description</th>
                <th>Cost</th>
                <th>Tax %</th>
                <th>Sale</th>
                <th className="hidden sm:table-cell">Margin</th>
                <th className="hidden lg:table-cell">Barcode</th>
                <th>Min Stock</th>
                <th className="hidden lg:table-cell">Properties</th>
                <th>Category</th>
                <th className="hidden xl:table-cell">Locations</th>
                <th className="hidden sm:table-cell">Promo</th>
                <th className="!px-2">Del</th>
              </tr>
            </thead>

            <tbody className="bg-white divide-y divide-gray-100">
              {productsLoading ? (
                <tr>
                  <td colSpan={16} className="p-8 text-center">
                    <Loader size="sm" text="Loading product list..." />
                  </td>
                </tr>
              ) : visibleProducts.length === 0 ? (
                <tr>
                  <td colSpan={16} className="p-6 text-center text-gray-500 italic">
                    No products found.
                  </td>
                </tr>
              ) : (
                visibleProducts.map((p, idx) => {
                  // calculate the real index inside filteredProducts (useful for editIndex)
                  const realIndex = pageStartIndex + idx;
                  const isHighlighted = highlightedId && highlightedId === p._id;
                  return (
                    <tr
                      key={p._id}
                      className={`transition cursor-pointer ${expandedRow === realIndex ? "bg-gray-50" : ""} ${
                        isHighlighted ? "ring-2 ring-blue-200 bg-gray-50" : ""
                      }`}
                      onClick={() => setExpandedRow(expandedRow === realIndex ? null : realIndex)}
                    >
                      <td className="p-2">
                        {editIndex === realIndex ? (
                          <div className="flex flex-col gap-1">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleUpdateClick(p._id);
                              }}
                              className="w-16 py-1 bg-green-600 text-white rounded text-xs"
                              disabled={savingProductId === p._id}
                            >
                              {savingProductId === p._id ? "Saving..." : "Save"}
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleCancelClick();
                              }}
                              className="w-16 py-1 bg-gray-300 text-gray-700 rounded text-xs"
                              disabled={savingProductId === p._id}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleEditClick(realIndex, p);
                            }}
                            className="py-1 px-2 md:px-3 border border-blue-600 text-blue-700 hover:bg-blue-600 hover:text-white rounded text-xs"
                          >
                            Edit
                          </button>
                        )}
                      </td>

                      <td className="p-2">
                        <input
                          type="checkbox"
                          checked={selectedProductIds.includes(p._id)}
                          onChange={(event) => {
                            event.stopPropagation();
                            toggleProductSelection(p._id);
                          }}
                          aria-label={`Select ${p.name}`}
                        />
                      </td>

                      <td className="p-2">
                        <Link
                          href={`/products/edit/${p._id}`}
                          onClick={() => {
                            rememberListPosition();
                            // persist highlight so when returning the row is still highlighted
                            sessionStorage.setItem("products:highlight", p._id);
                          }}
                        >
                          <button
                            onClick={(e) => e.stopPropagation()}
                            className="py-1 px-2 md:px-3 border border-gray-300 text-blue-600 hover:bg-blue-600 hover:text-white rounded text-xs transition"
                          >
                            Adv
                          </button>
                        </Link>
                      </td>

                      <td className="p-2 font-semibold text-xs md:text-sm">
                        {editIndex === realIndex ? (
                          <input
                            name="name"
                            value={editableProduct.name || ""}
                            onChange={handleChange}
                            onClick={(e) => e.stopPropagation()}
                            className="w-32 md:w-36 border p-1 rounded text-xs"
                          />
                        ) : (
                          <span>
                            {p.name}
                            {p.isChildProduct && p.packType !== "pack" && (
                              <span className="ml-1 text-[10px] text-blue-500 font-normal">(unit from pack)</span>
                            )}
                            {p.packType === "pack" && (
                              <span className="ml-1 text-[10px] text-purple-500 font-normal">(pack of {p.qtyPerPack})</span>
                            )}
                          </span>
                        )}
                      </td>

                      <td className="p-2 hidden sm:table-cell max-w-[190px] text-xs align-top">
                        {editIndex === realIndex ? (
                          <textarea
                            name="description"
                            value={editableProduct.description || ""}
                            onChange={handleChange}
                            onClick={(e) => e.stopPropagation()}
                            rows={3}
                            className="w-full min-w-[180px] border p-1 rounded text-xs resize-none"
                          />
                        ) : (
                          <div className="truncate">{p.description}</div>
                        )}
                      </td>


                      <td className="p-2 text-xs md:text-sm">
                        {editIndex === realIndex ? (
                          <input
                            name="costPrice"
                            value={editableProduct.costPrice || ""}
                            onChange={handleChange}
                            onClick={(e) => e.stopPropagation()}
                            onWheel={(e) => e.currentTarget.blur()}
                            type="number"
                            className="w-16 md:w-20 border p-1 rounded text-xs"
                          />
                        ) : (
                          formatCurrency(p.costPrice)
                        )}
                      </td>

                      <td className="p-2 text-xs md:text-sm">
                        {editIndex === realIndex ? (
                          <select
                            name="taxRate"
                            value={editableProduct.taxRate || ""}
                            onChange={handleChange}
                            onClick={(e) => e.stopPropagation()}
                            className="w-16 md:w-20 border p-1 rounded text-xs"
                          >
                            <option value="4.5">4.5%</option>
                            <option value="7.5">7.5%</option>
                          </select>
                        ) : (
                          p.taxRate
                        )}
                      </td>

                      <td className="p-2 text-gray-900 font-semibold text-xs md:text-sm">
                        {editIndex === realIndex ? (
                          <input
                            name="salePriceIncTax"
                            value={editableProduct.salePriceIncTax || ""}
                            onChange={handleChange}
                            onClick={(e) => e.stopPropagation()}
                            onWheel={(e) => e.currentTarget.blur()}
                            type="number"
                            className="w-16 md:w-20 border p-1 rounded text-xs"
                          />
                        ) : (
                          formatCurrency(p.salePriceIncTax)
                        )}
                      </td>

                      <td className="p-2 hidden sm:table-cell text-xs">
                        {editIndex === realIndex ? (
                          <input
                            name="margin"
                            value={editableProduct.margin || ""}
                            onChange={handleChange}
                            onClick={(e) => e.stopPropagation()}
                            onWheel={(e) => e.currentTarget.blur()}
                            type="number"
                            className="w-14 md:w-16 border p-1 rounded text-xs"
                          />
                        ) : (
                          p.margin
                        )}
                      </td>
                      <td className="p-2 hidden lg:table-cell text-xs">
                        {editIndex === realIndex ? (
                          <input
                            name="barcode"
                            value={editableProduct.barcode || ""}
                            onChange={handleChange}
                            onClick={(e) => e.stopPropagation()}
                            className="w-28 border p-1 rounded text-xs"
                          />
                        ) : (
                          p.barcode
                        )}
                      </td>

                      <td className="p-2 text-xs md:text-sm">
                        {editIndex === realIndex ? (
                          <input
                            name="minStock"
                            value={editableProduct.minStock ?? ""}
                            onChange={handleChange}
                            onClick={(e) => e.stopPropagation()}
                            onWheel={(e) => e.currentTarget.blur()}
                            type="number"
                            className="w-16 md:w-20 border p-1 rounded text-xs"
                          />
                        ) : (
                          p.minStock ?? ""
                        )}
                      </td>

                      <td className="p-2 hidden lg:table-cell text-gray-600 text-xs align-top">
                        {editIndex === realIndex ? (
                          <textarea
                            value={propertiesText}
                            onChange={(e) => setPropertiesText(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            rows={3}
                            placeholder="Size: Large\nColor: Red"
                            className="w-full min-w-[180px] border p-1 rounded text-xs resize-none"
                          />
                        ) : (
                          p.properties?.length > 0
                            ? p.properties.map((pr) => `${pr.propName}: ${pr.propValue}`).join(", ")
                            : ""
                        )}
                      </td>

                      <td className="p-2 text-xs md:text-sm">
                        {editIndex === realIndex ? (
                          <select
                            name="category"
                            value={editableProduct.category || ""}
                            onChange={handleChange}
                            onClick={(e) => e.stopPropagation()}
                            className="w-32 border p-1 rounded text-xs"
                          >
                            <option value="">Select category</option>
                            {allCategoryOptions.map((category) => (
                              <option key={category.id} value={category.id}>
                                {category.label}
                              </option>
                            ))}
                            {!allCategoryOptions.some((category) => category.id === editableProduct.category) && (
                              <option value={editableProduct.category || "Top Level"}>
                                {editableProduct.category || "Top Level"}
                              </option>
                            )}
                          </select>
                        ) : (
                          categoryMap[p.category] || p.category || ""
                        )}
                      </td>

                      <td className="p-2 hidden xl:table-cell text-xs text-gray-600 align-top">
                        {Array.isArray(p.locations) && p.locations.length > 0
                          ? p.locations.join(", ")
                          : "Unassigned"}
                      </td>

                      <td className="p-2 hidden sm:table-cell text-xs">
                        {p.isPromotion ? (
                          <span className="text-green-600 font-semibold">Yes</span>
                        ) : (
                          <span className="text-gray-400">No</span>
                        )}
                      </td>

                      <td className="p-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteClick(p._id);
                          }}
                          className="py-1 px-2 md:px-3 bg-red-50 text-red-700 border border-red-300 hover:bg-red-600 hover:text-white rounded text-xs"
                        >
                          X
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination controls */}
        <div className="mt-6 rounded-lg border border-gray-200 bg-white px-4 py-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-col gap-2 text-sm text-gray-600 sm:flex-row sm:items-center sm:gap-3">
              <span>
                {totalFilteredProducts > 0
                  ? `Showing ${pageStartIndex + 1}-${pageEndIndex} of ${totalFilteredProducts}`
                  : "No products to show"}
              </span>
              <label className="flex items-center gap-2">
                <span className="text-gray-500">Rows</span>
                <select
                  className="form-select !w-auto !py-1.5 text-sm"
                  value={entriesPerPage}
                  onChange={handleEntriesPerPageChange}
                >
                  {entriesPerPageOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {totalFilteredProducts > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => goToPage(1)}
                  disabled={safeCurrentPage <= 1}
                  className={paginationButtonClass}
                >
                  First
                </button>
                <button
                  type="button"
                  onClick={() => goToPage(safeCurrentPage - 1)}
                  disabled={safeCurrentPage <= 1}
                  className={paginationButtonClass}
                >
                  Previous
                </button>

                {paginationPages.map(renderPageButton)}

                <button
                  type="button"
                  onClick={() => goToPage(safeCurrentPage + 1)}
                  disabled={safeCurrentPage >= totalPages}
                  className={paginationButtonClass}
                >
                  Next
                </button>
                <button
                  type="button"
                  onClick={() => goToPage(totalPages)}
                  disabled={safeCurrentPage >= totalPages}
                  className={paginationButtonClass}
                >
                  Last
                </button>
              </div>
            )}
          </div>
        </div>

        {showPriceListModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
            <div className="w-full max-w-xl rounded-xl border border-gray-200 bg-white p-6 shadow-xl">
              <h2 className="text-lg font-semibold text-gray-900">Print Product Price List</h2>
              <p className="mt-1 text-sm text-gray-500">
                Choose what to include and download as PDF.
              </p>

              {/* Source selection */}
              <div className="mt-5 space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Source</p>
                <label className="flex items-center gap-2 text-sm text-gray-800">
                  <input
                    type="radio"
                    name="priceListMode"
                    value="all"
                    checked={priceListMode === "all"}
                    onChange={(event) => setPriceListMode(event.target.value)}
                  />
                  All products ({allProducts.length})
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-800">
                  <input
                    type="radio"
                    name="priceListMode"
                    value="filtered"
                    checked={priceListMode === "filtered"}
                    onChange={(event) => setPriceListMode(event.target.value)}
                  />
                  Current filtered list ({filteredProducts.length})
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-800">
                  <input
                    type="radio"
                    name="priceListMode"
                    value="selected"
                    checked={priceListMode === "selected"}
                    onChange={(event) => setPriceListMode(event.target.value)}
                  />
                  Selected products ({selectedProductIds.length})
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-800">
                  <input
                    type="radio"
                    name="priceListMode"
                    value="category"
                    checked={priceListMode === "category"}
                    onChange={(event) => setPriceListMode(event.target.value)}
                  />
                  By category
                </label>
              </div>

              {/* Category multi-select */}
              {priceListMode === "category" && (
                <div className="mt-3 rounded-lg border border-gray-200 p-3">
                  <p className="mb-2 text-xs font-medium text-gray-600">
                    Select categories (leave all unchecked for all categories)
                  </p>
                  <div className="max-h-40 space-y-1 overflow-y-auto">
                    {allCategoryOptions.map((category) => (
                      <label key={category.id} className="flex items-center gap-2 text-sm text-gray-700">
                        <input
                          type="checkbox"
                          checked={priceListCategories.includes(category.id)}
                          onChange={(event) => {
                            if (event.target.checked) {
                              setPriceListCategories((prev) => [...prev, category.id]);
                            } else {
                              setPriceListCategories((prev) => prev.filter((id) => id !== category.id));
                            }
                          }}
                        />
                        {category.label}
                      </label>
                    ))}
                  </div>
                  {priceListCategories.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setPriceListCategories([])}
                      className="mt-2 text-xs text-blue-600 hover:underline"
                    >
                      Clear selection ({priceListCategories.length} selected)
                    </button>
                  )}
                </div>
              )}

              {/* Filters */}
              <div className="mt-4 rounded-lg border border-gray-100 bg-gray-50 p-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">Filters</p>
                <label className="flex items-center gap-2 text-sm text-gray-800">
                  <input
                    type="checkbox"
                    checked={priceListExcludeUnitProducts}
                    onChange={(event) => setPriceListExcludeUnitProducts(event.target.checked)}
                  />
                  Exclude unit/child products (show only standard &amp; parent products)
                </label>
              </div>

              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={closePriceListModal}
                  className="btn-action-secondary"
                  disabled={isPrintingPriceList}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handlePrintPriceList}
                  disabled={isPrintingPriceList}
                  className="btn-action-primary"
                >
                  {isPrintingPriceList ? "Preparing PDF..." : "Download PDF"}
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


