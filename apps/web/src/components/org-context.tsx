"use client";

import { createContext, useContext, useEffect, useState } from "react";

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
}

interface OrgContextValue {
  orgs: OrgSummary[];
  selectedOrg: OrgSummary | null;
  selectOrg: (orgId: string) => void;
}

const OrgContext = createContext<OrgContextValue>({
  orgs: [],
  selectedOrg: null,
  selectOrg: () => undefined,
});

export function useOrg(): OrgContextValue {
  return useContext(OrgContext);
}

export function OrgProvider({
  orgs,
  children,
}: {
  orgs: OrgSummary[];
  children: React.ReactNode;
}) {
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);

  useEffect(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem("graphite.org") : null;
    if (saved && orgs.some((o) => o.id === saved)) {
      setSelectedOrgId(saved);
    } else if (orgs.length > 0 && (selectedOrgId === null || !orgs.some((o) => o.id === selectedOrgId))) {
      setSelectedOrgId(orgs[0]?.id ?? null);
    }
    // Only reacts to the org list changing; selectedOrgId is intentionally
    // omitted to avoid reset loops on selection.
  }, [orgs]);

  function selectOrg(orgId: string) {
    setSelectedOrgId(orgId);
    localStorage.setItem("graphite.org", orgId);
  }

  const selectedOrg = orgs.find((o) => o.id === selectedOrgId) ?? null;
  return (
    <OrgContext.Provider value={{ orgs, selectedOrg, selectOrg }}>
      {children}
    </OrgContext.Provider>
  );
}
