"use client";
import { useEffect, useRef, useState } from "react";
import { api, ErrorNotice } from "./ui";

type PickerAsset = {
  id: string;
  name: string;
  asset_tag?: string | null;
  customer_id?: string;
  customer_name?: string;
  site_name?: string;
  status?: string;
};

export function AssetPicker({
  ids,
  initial,
  invalid,
  customerScope,
  onChange,
}: {
  ids: string[];
  initial?: Record<string, any>;
  invalid: boolean;
  customerScope?: string;
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<PickerAsset[]>([]);
  const [known, setKnown] = useState<Record<string, PickerAsset>>(() =>
    Object.fromEntries(
      (initial?.assets || []).map((asset: PickerAsset) => [
        asset.id,
        {
          customer_id: initial?.customer_id,
          customer_name: initial?.customer_name,
          ...asset,
        },
      ]),
    ),
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const picker = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const customerId =
    customerScope ??
    (initial?.customer_id ||
      (ids.length ? known[ids[0]]?.customer_id : "") ||
      "");
  const needsCustomer = customerScope !== undefined && !customerScope;
  const missingIds = ids
    .filter((id) => !known[id]?.name || !known[id]?.customer_id)
    .join(",");

  useEffect(() => {
    if (pendingFocus.current === null) return;
    const target = pendingFocus.current
      ? picker.current?.querySelector<HTMLInputElement>(
          `[data-asset-id="${pendingFocus.current}"]`,
        )
      : searchInput.current;
    target?.focus();
    pendingFocus.current = null;
  }, [ids]);

  useEffect(() => {
    if (!missingIds) return;
    let cancelled = false;
    Promise.all(
      missingIds.split(",").map((id) => api("/api/data/assets/" + id)),
    )
      .then((assets: PickerAsset[]) => {
        if (!cancelled)
          setKnown((old) => ({
            ...old,
            ...Object.fromEntries(assets.map((asset) => [asset.id, asset])),
          }));
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [missingIds]);

  useEffect(() => {
    let cancelled = false;
    if (needsCustomer) {
      setCandidates([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError("");
    api(
      "/api/lookups?" +
        new URLSearchParams({
          entity: "assets",
          q: query,
          ...(customerId ? { customer_id: customerId } : {}),
        }),
    )
      .then((result: { assets: PickerAsset[] }) => {
        if (cancelled) return;
        setCandidates(result.assets);
        setKnown((old) => ({
          ...old,
          ...Object.fromEntries(
            result.assets.map((asset) => [asset.id, asset]),
          ),
        }));
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query, customerId, needsCustomer]);

  const selected = new Set(ids);
  const available = candidates.filter(
    (asset) =>
      !selected.has(asset.id) &&
      (!customerId || asset.customer_id === customerId),
  );
  function row(asset: PickerAsset, checked: boolean) {
    return (
      <label key={asset.id}>
        <input
          type="checkbox"
          data-asset-id={asset.id}
          checked={checked}
          disabled={!checked && ids.length >= 200}
          onChange={(event) => {
            pendingFocus.current = event.target.checked ? asset.id : "";
            onChange(
              event.target.checked
                ? [...ids, asset.id]
                : ids.filter((id) => id !== asset.id),
            );
          }}
        />
        <span>
          {asset.name}
          <small>
            {[
              asset.asset_tag || "자산번호 미등록",
              asset.customer_name,
              asset.site_name,
            ]
              .filter(Boolean)
              .join(" · ")}
          </small>
          {asset.status === "archived" && (
            <small>보관·비활성 · 기존 연결</small>
          )}
        </span>
      </label>
    );
  }
  return (
    <div
      ref={picker}
      id="field-asset_ids"
      className="inspection-asset-picker"
      role="group"
      tabIndex={-1}
      aria-labelledby="field-asset_ids-label"
      aria-invalid={invalid}
      aria-describedby={
        "inspection-assets-help" + (invalid ? " field-asset_ids-error" : "")
      }
    >
      <div className="inspection-asset-summary">
        <strong aria-live="polite">{ids.length}개 선택</strong>
        <span className="footnote" id="inspection-assets-help">
          같은 고객사의 자산만 최대 200개까지 함께 선택할 수 있습니다.
        </span>
      </div>
      {ids.length > 0 && (
        <div
          className="checkbox-list inspection-asset-selected"
          role="group"
          aria-label="선택한 자산"
        >
          {ids.map((id) =>
            row(known[id] || { id, name: "자산 정보를 불러오는 중…" }, true),
          )}
        </div>
      )}
      <input
        ref={searchInput}
        aria-label="대상 자산 후보 검색"
        placeholder="자산명, 자산번호, 고객사 검색 (최대 100건)"
        disabled={needsCustomer}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <ErrorNotice message={loadError} />
      <div className="checkbox-list" aria-busy={loading}>
        {needsCustomer ? (
          <span className="muted">고객사를 먼저 선택해 주세요.</span>
        ) : loading ? (
          <span className="muted" role="status">
            자산을 불러오는 중…
          </span>
        ) : available.length ? (
          available.map((asset) => row(asset, false))
        ) : (
          <span className="muted">검색 조건에 맞는 자산이 없습니다.</span>
        )}
      </div>
    </div>
  );
}
