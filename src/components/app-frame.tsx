"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { DatabaseZap, LayoutDashboard, List, MessageSquareText, Wallet } from "lucide-react";
import { BrandLogo } from "./brand-logo";

const PRIMARY_LINKS = [
  { href: "/", label: "Home", icon: LayoutDashboard },
  { href: "/portfolio", label: "Portfolio", icon: Wallet },
];

type UtilityLink = {
  href: string;
  label: string;
  description: string;
  icon: LucideIcon;
  activeMatch: string;
};

type UtilityGroup = {
  title: string;
  links: UtilityLink[];
};

const UTILITY_GROUPS: UtilityGroup[] = [
  {
    title: "Data",
    links: [
      {
        href: "/load-data",
        label: "Load data",
        description: "Import statements and rerun parsing",
        icon: DatabaseZap,
        activeMatch: "/load-data",
      },
      {
        href: "/transactions",
        label: "Transactions",
        description: "Ledger, review queue, and fixes",
        icon: List,
        activeMatch: "/transactions",
      },
    ],
  },
  {
    title: "Tools",
    links: [
      {
        href: "/assistant",
        label: "Ask AI",
        description: "Charts and quick questions",
        icon: MessageSquareText,
        activeMatch: "/assistant",
      },
    ],
  },
];

const SIDEBAR_DRAFT_KEY = "cashflow_assistant_draft";

export function readQueuedAssistantDraft() {
  if (typeof window === "undefined") {
    return "";
  }
  return window.sessionStorage.getItem(SIDEBAR_DRAFT_KEY) ?? "";
}

export function clearQueuedAssistantDraft() {
  if (typeof window === "undefined") {
    return;
  }
  window.sessionStorage.removeItem(SIDEBAR_DRAFT_KEY);
}

export function AppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "";

  const normalizedPath = useMemo(() => {
    if (pathname.startsWith("/accounts")) {
      return "/portfolio";
    }
    if (pathname.startsWith("/operations")) {
      return "/transactions";
    }
    if (pathname.startsWith("/settings")) {
      return "/transactions";
    }
    if (pathname.startsWith("/load-data")) {
      return "/load-data";
    }
    if (pathname.startsWith("/spending")) {
      return "/transactions";
    }
    return pathname;
  }, [pathname]);

  const activePrimaryLink = useMemo(
    () => PRIMARY_LINKS.find((item) => (item.href === "/" ? normalizedPath === "/" : normalizedPath.startsWith(item.href)))?.href ?? "",
    [normalizedPath],
  );

  const activeUtilityLink = useMemo(
    () =>
      UTILITY_GROUPS.flatMap((group) => group.links).find((item) => normalizedPath.startsWith(item.activeMatch))?.href ?? "",
    [normalizedPath],
  );

  return (
    <div className="app-frame">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-lockup">
            <BrandLogo size={46} />
            <div className="brand-wording">
              <h1>Track Republic</h1>
            </div>
          </div>
          <p>Private cashflow, portfolio, and local tools.</p>
        </div>

        <nav className="sidebar-nav" aria-label="Primary">
          {PRIMARY_LINKS.map((link) => {
            const Icon = link.icon;
            return (
              <Link key={link.href} href={link.href} className="sidebar-link" data-active={activePrimaryLink === link.href}>
                <span className="sidebar-link-icon">
                  <Icon size={18} />
                </span>
                <span>
                  <strong>{link.label}</strong>
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-card">
          <div className="sidebar-card-head">
            <span className="sidebar-kicker">Utilities</span>
          </div>
          <div className="sidebar-tool-groups">
            {UTILITY_GROUPS.map((group) => (
              <div key={group.title} className="sidebar-tool-group">
                <div className="sidebar-tool-group-title">{group.title}</div>
                <div className="sidebar-tool-list">
                  {group.links.map((link) => {
                    const Icon = link.icon;
                    return (
                      <Link key={link.href} href={link.href} className="sidebar-tool-link" data-active={activeUtilityLink === link.href}>
                        <span className="sidebar-link-icon">
                          <Icon size={18} />
                        </span>
                        <span>
                          <strong>{link.label}</strong>
                          <small>{link.description}</small>
                        </span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </aside>

      <div className="app-main">{children}</div>
    </div>
  );
}
