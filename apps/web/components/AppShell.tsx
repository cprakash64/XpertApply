"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import {
  BriefcaseBusiness,
  ClipboardList,
  FileText,
  Gauge,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  UserRound,
  X
} from "lucide-react";
import {
  AUTH_SESSION_INVALIDATED_EVENT,
  hasUsableStoredSession,
  invalidateAuthSession,
  subscribeAuthSession,
  type AuthSessionInvalidationDetail
} from "@/lib/authSession";

/**
 * Primary navigation, ordered by how a job search actually flows: see where you
 * stand, find roles, prepare materials, track what you sent, then maintain the
 * profile behind all of it.
 *
 * Every entry points at a route that exists. "Networking" is deliberately
 * absent: the people/referral features are a tab inside the Jobs workspace, not
 * a standalone page, and adding a sidebar entry for it would be a link to a
 * 404. It belongs here once it has its own route.
 */
const nav = [
  { href: "/dashboard", label: "Dashboard", icon: Gauge, activeRoots: ["/dashboard"] },
  { href: "/jobs", label: "Find Jobs", icon: BriefcaseBusiness, activeRoots: ["/jobs", "/matches"] },
  {
    href: "/resume",
    label: "My Resumes",
    icon: FileText,
    activeRoots: ["/resume", "/cover-letter", "/application-answers"]
  },
  { href: "/tracker", label: "Applications", icon: ClipboardList, activeRoots: ["/tracker"] },
  { href: "/profile", label: "My Profile", icon: UserRound, activeRoots: ["/profile"] }
] as const;

const settingsItem = {
  href: "/settings",
  label: "Settings",
  icon: Settings,
  activeRoots: ["/settings"]
} as const;

const DESKTOP_SIDEBAR_PREFERENCE_KEY = "xpertapply:desktop-sidebar-collapsed";
const DESKTOP_SIDEBAR_PREFERENCE_EVENT = "xpertapply:desktop-sidebar-preference";
const TABLET_MEDIA_QUERY = "(min-width: 640px) and (max-width: 1279px)";
const MOBILE_MEDIA_QUERY = "(max-width: 639px)";

function readDesktopSidebarPreference(): boolean | null {
  const saved = window.localStorage.getItem(DESKTOP_SIDEBAR_PREFERENCE_KEY);
  return saved === "true" ? true : saved === "false" ? false : null;
}

function subscribeDesktopSidebarPreference(onChange: () => void): () => void {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === DESKTOP_SIDEBAR_PREFERENCE_KEY) onChange();
  };
  window.addEventListener("storage", handleStorage);
  window.addEventListener(DESKTOP_SIDEBAR_PREFERENCE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(DESKTOP_SIDEBAR_PREFERENCE_EVENT, onChange);
  };
}

const subscribeHydration = () => () => undefined;
const getClientHydrationSnapshot = () => true;
const getServerHydrationSnapshot = () => false;

type AppShellApi = {
  collapsed: boolean;
  /**
   * A page asks for the rail (e.g. the Jobs detail workspace opened). The user's
   * own expand/collapse choice wins until the request itself changes, so
   * re-expanding the sidebar while reading a job is not undone on every render.
   */
  requestCollapsed: (collapsed: boolean) => void;
};

const AppShellContext = createContext<AppShellApi | null>(null);

/** Null outside an AppShell, so components remain renderable on their own. */
export function useAppShell(): AppShellApi | null {
  return useContext(AppShellContext);
}

export function AppShell({
  children,
  /** Full-bleed pages (the Jobs master-detail workspace) manage their own
   * padding and scroll containers instead of the centred page container. */
  workspace = false
}: {
  children: React.ReactNode;
  workspace?: boolean;
}) {
  const sessionAvailable = useProtectedSession();
  const pathname = usePathname();
  // One state object keeps the two inputs consistent: a new request from the
  // page always clears a stale user override, without a side effect inside an
  // updater.
  const [state, setState] = useState<{ requested: boolean; override: boolean | null }>({
    requested: false,
    override: null
  });
  const persistedDesktopCollapsed = useSyncExternalStore(
    subscribeDesktopSidebarPreference,
    readDesktopSidebarPreference,
    () => null
  );
  const desktopCollapsed = state.override ?? (state.requested || persistedDesktopCollapsed === true);
  const [tabletState, setTabletState] = useState<{ expanded: boolean; pathname: string | null }>({
    expanded: false,
    pathname: null
  });
  const [mobileState, setMobileState] = useState<{ open: boolean; pathname: string | null }>({
    open: false,
    pathname: null
  });
  // Route-keyed transient state closes without a follow-up render or effect.
  const tabletExpanded = tabletState.expanded && tabletState.pathname === pathname;
  const mobileOpen = mobileState.open && mobileState.pathname === pathname;
  const mobileTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileCloseRef = useRef<HTMLButtonElement>(null);
  const mobileDrawerRef = useRef<HTMLDivElement>(null);
  const backgroundRef = useRef<HTMLDivElement>(null);
  const mobileWasOpen = useRef(false);
  const restoreMobileFocus = useRef(true);
  // The page's own request — not the user's sidebar preference — is what says
  // "this screen fills the viewport and manages its own scrolling".
  const immersive = workspace && state.requested;

  const requestCollapsed = useCallback((value: boolean) => {
    setState((current) =>
      current.requested === value ? current : { requested: value, override: null }
    );
  }, []);

  const toggleDesktop = useCallback(() => {
    const next = !desktopCollapsed;
    setState((current) => ({ ...current, override: next }));
    window.localStorage.setItem(DESKTOP_SIDEBAR_PREFERENCE_KEY, String(next));
    window.dispatchEvent(new Event(DESKTOP_SIDEBAR_PREFERENCE_EVENT));
  }, [desktopCollapsed]);

  const closeMobile = useCallback((returnFocus: boolean) => {
    restoreMobileFocus.current = returnFocus;
    setMobileState({ open: false, pathname });
  }, [pathname]);

  // Breakpoint changes are discrete lifecycle events, not a continuous resize
  // stream. CSS owns layout; these listeners only retire now-invalid overlays.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const tablet = window.matchMedia(TABLET_MEDIA_QUERY);
    const mobile = window.matchMedia(MOBILE_MEDIA_QUERY);
    const reconcile = () => {
      if (!tablet.matches) setTabletState({ expanded: false, pathname });
      if (!mobile.matches) closeMobile(false);
    };
    tablet.addEventListener("change", reconcile);
    mobile.addEventListener("change", reconcile);
    reconcile();
    return () => {
      tablet.removeEventListener("change", reconcile);
      mobile.removeEventListener("change", reconcile);
    };
  }, [closeMobile, pathname]);

  // The mobile drawer is a modal interaction: trap keyboard focus, lock the
  // underlying document, and restore the opener when dismissal stays in place.
  useEffect(() => {
    if (!mobileOpen || !sessionAvailable) {
      if (mobileWasOpen.current && restoreMobileFocus.current) {
        mobileTriggerRef.current?.focus();
      }
      mobileWasOpen.current = false;
      return;
    }

    mobileWasOpen.current = true;
    restoreMobileFocus.current = true;
    const background = backgroundRef.current;
    document.documentElement.classList.add("app-drawer-open");
    background?.setAttribute("inert", "");
    mobileCloseRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMobile(true);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = mobileDrawerRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.documentElement.classList.remove("app-drawer-open");
      background?.removeAttribute("inert");
    };
  }, [closeMobile, mobileOpen, sessionAvailable]);

  useEffect(() => {
    if (!tabletExpanded) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTabletState({ expanded: false, pathname });
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [pathname, tabletExpanded]);

  // Pinning the document is the only reliable way to guarantee the page itself
  // never contributes a scrollbar behind a viewport-height layout.
  useEffect(() => {
    if (!immersive) {
      return;
    }
    const root = document.documentElement;
    root.classList.add("workspace-locked");
    return () => root.classList.remove("workspace-locked");
  }, [immersive]);

  const api = useMemo<AppShellApi>(
    () => ({ collapsed: desktopCollapsed, requestCollapsed }),
    [desktopCollapsed, requestCollapsed]
  );

  if (!sessionAvailable) {
    return (
      <main className="grid min-h-screen place-items-center" aria-busy="true">
        <p className="sr-only" role="status">Checking your session…</p>
      </main>
    );
  }

  return (
    <AppShellContext.Provider value={api}>
      {/*
        * A workspace page sizes itself to the *dynamic* viewport, matching the
        * detail layout's own 100dvh: min-h-screen (100vh) is taller than the
        * visible area wherever browser chrome collapses, which left the whole
        * page scrollable behind a full-height layout.
        *
        * While a page is in immersive mode (the Jobs detail workspace), the
        * document itself is pinned so the only scrollbars on screen are the two
        * the layout owns — the job list and the detail panel.
        */}
      <div
        className={`app-shell bg-[var(--background)] ${
          workspace ? "min-h-[100dvh]" : "min-h-screen"
        } ${immersive ? "h-[100dvh] overflow-hidden" : ""}`}
        data-desktop-collapsed={desktopCollapsed ? "true" : "false"}
      >
        <div ref={backgroundRef} className={immersive ? "h-full" : "min-h-[inherit]"}>
          <MobileHeader
            menuRef={mobileTriggerRef}
            open={mobileOpen}
            onOpen={() => {
              restoreMobileFocus.current = true;
              setMobileState({ open: true, pathname });
            }}
          />
          <SideBar
            desktopCollapsed={desktopCollapsed}
            tabletExpanded={tabletExpanded}
            onDesktopToggle={toggleDesktop}
            onTabletToggle={() =>
              setTabletState({ expanded: !tabletExpanded, pathname })
            }
          />
          <main
            className={`app-shell-main ${
              immersive ? "h-[calc(100dvh-3.5rem)] sm:h-full" : ""
            }`}
          >
            {workspace ? (
              children
            ) : (
              <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">{children}</div>
            )}
          </main>
        </div>

        {tabletExpanded ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label="Close expanded navigation"
            className="fixed inset-0 z-20 hidden bg-surface-overlay sm:block xl:hidden"
            onClick={() => setTabletState({ expanded: false, pathname })}
          />
        ) : null}

        {mobileOpen ? (
          <MobileDrawer
            closeRef={mobileCloseRef}
            drawerRef={mobileDrawerRef}
            onClose={() => closeMobile(true)}
            onNavigate={() => closeMobile(false)}
          />
        ) : null}
      </div>
    </AppShellContext.Provider>
  );
}

function MobileHeader({
  menuRef,
  open,
  onOpen
}: {
  menuRef: React.RefObject<HTMLButtonElement>;
  open: boolean;
  onOpen: () => void;
}) {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line-default bg-surface-shell px-3 shadow-subtle sm:hidden">
      <button
        ref={menuRef}
        type="button"
        aria-label="Open navigation"
        aria-expanded={open}
        aria-controls="mobile-app-navigation"
        onClick={onOpen}
        className="ds-focus-ring grid h-11 w-11 place-items-center rounded-control text-foreground-secondary transition-colors duration-fast hover:bg-surface-subtle hover:text-foreground"
      >
        <Menu className="h-5 w-5" aria-hidden />
      </button>
      <Brand compact={false} />
    </header>
  );
}

function SideBar({
  desktopCollapsed,
  tabletExpanded,
  onDesktopToggle,
  onTabletToggle
}: {
  desktopCollapsed: boolean;
  tabletExpanded: boolean;
  onDesktopToggle: () => void;
  onTabletToggle: () => void;
}) {
  return (
    <aside
      aria-label="Primary"
      data-collapsed={desktopCollapsed ? "true" : "false"}
      data-tablet-expanded={tabletExpanded ? "true" : "false"}
      className="app-sidebar"
    >
      <Brand compact />
      <PrimaryNavigation />
      <NavigationFooter />
      <div className="app-sidebar-toggle mt-1">
        <button
          type="button"
          onClick={onTabletToggle}
          aria-expanded={tabletExpanded}
          aria-label={tabletExpanded ? "Collapse navigation" : "Expand navigation"}
          className="app-nav-link app-tablet-toggle ds-focus-ring group"
        >
          {tabletExpanded ? (
            <PanelLeftClose className="h-4 w-4 shrink-0" aria-hidden />
          ) : (
            <PanelLeftOpen className="h-4 w-4" aria-hidden />
          )}
          <span className="app-nav-label">
            {tabletExpanded ? "Collapse navigation" : "Expand navigation"}
          </span>
          {!tabletExpanded ? <RailTooltip>Expand navigation</RailTooltip> : null}
        </button>
        <button
          type="button"
          onClick={onDesktopToggle}
          aria-expanded={!desktopCollapsed}
          aria-label={desktopCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="app-nav-link app-desktop-toggle ds-focus-ring group"
        >
          {desktopCollapsed ? (
            <PanelLeftOpen className="h-4 w-4 shrink-0" aria-hidden />
          ) : (
            <PanelLeftClose className="h-4 w-4 shrink-0" aria-hidden />
          )}
          <span className="app-nav-label">
            {desktopCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          </span>
          {desktopCollapsed ? <RailTooltip>Expand sidebar</RailTooltip> : null}
        </button>
      </div>
    </aside>
  );
}

function MobileDrawer({
  closeRef,
  drawerRef,
  onClose,
  onNavigate
}: {
  closeRef: React.RefObject<HTMLButtonElement>;
  drawerRef: React.RefObject<HTMLDivElement>;
  onClose: () => void;
  onNavigate: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 sm:hidden">
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close navigation"
        data-testid="mobile-navigation-backdrop"
        className="absolute inset-0 bg-surface-overlay"
        onClick={onClose}
      />
      <div
        ref={drawerRef}
        id="mobile-app-navigation"
        role="dialog"
        aria-modal="true"
        aria-label="Application navigation"
        className="relative flex h-full w-[min(20rem,86vw)] flex-col overflow-y-auto border-r border-line-default bg-surface-shell p-4 shadow-overlay"
      >
        <div className="mb-6 flex items-center justify-between gap-3">
          <Brand compact={false} onNavigate={onNavigate} />
          <button
            ref={closeRef}
            type="button"
            aria-label="Close navigation"
            onClick={onClose}
            className="ds-focus-ring grid h-11 w-11 place-items-center rounded-control text-foreground-secondary transition-colors duration-fast hover:bg-surface-subtle hover:text-foreground"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <PrimaryNavigation onNavigate={onNavigate} />
        <NavigationFooter onNavigate={onNavigate} />
      </div>
    </div>
  );
}

function Brand({ compact, onNavigate }: { compact: boolean; onNavigate?: () => void }) {
  return (
    <Link
      href="/"
      aria-label="XpertApply home"
      onClick={onNavigate}
      className={`app-brand ds-focus-ring group flex items-center rounded-control font-semibold ${
        compact ? "py-2" : "gap-2 px-1 py-1"
      }`}
    >
      <span aria-hidden className="app-brand-mark">
        <Image
          src="/brand/xpertapply-logo.png"
          alt=""
          width={116}
          height={87}
          unoptimized
        />
      </span>
      <span className={compact ? "app-brand-label" : undefined} aria-hidden>
        <span className="text-foreground">Xpert</span>
        <span className="text-brand-accent">Apply</span>
      </span>
    </Link>
  );
}

function PrimaryNavigation({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Sections" className="app-primary-nav space-y-1">
      {nav.map((item) => (
        <NavItem
          key={item.href}
          {...item}
          active={isItemActive(pathname, item.activeRoots)}
          onNavigate={onNavigate}
        />
      ))}
    </nav>
  );
}

function NavigationFooter({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <div className="app-navigation-footer mt-auto space-y-1 border-t border-line-subtle pt-4">
      <NavItem
        {...settingsItem}
        active={isItemActive(pathname, settingsItem.activeRoots)}
        onNavigate={onNavigate}
      />
      <button
        type="button"
        onClick={() => invalidateAuthSession({ reason: "logout", returnTo: null })}
        aria-label="Log out"
        className="app-nav-link app-logout-link ds-focus-ring group"
      >
        <LogOut className="h-4 w-4 shrink-0" aria-hidden />
        <span className="app-nav-label">Log out</span>
        <RailTooltip>Log out</RailTooltip>
      </button>
    </div>
  );
}

function isItemActive(pathname: string | null, roots: readonly string[]): boolean {
  return roots.some(
    (root) => pathname === root || pathname?.startsWith(`${root}/`)
  );
}

/**
 * Shared client boundary for every authenticated page. Protected chrome is not
 * rendered until local auth is resolved, and a central 401 event removes it
 * synchronously before replacement navigation.
 */
function useProtectedSession(): boolean {
  const pathname = usePathname();
  const router = useRouter();
  // During production hydration, useSyncExternalStore intentionally returns
  // its server snapshot first. Do not interpret that one frame as a real
  // logged-out transition and clear a valid token before the client snapshot.
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    getClientHydrationSnapshot,
    getServerHydrationSnapshot
  );
  const available = useSyncExternalStore(
    subscribeAuthSession,
    hasUsableStoredSession,
    () => false
  );

  useEffect(() => {
    const handleInvalidation = (event: Event) => {
      const detail = (event as CustomEvent<AuthSessionInvalidationDetail>).detail;
      router.replace(detail?.loginHref ?? "/login");
    };
    window.addEventListener(AUTH_SESSION_INVALIDATED_EVENT, handleInvalidation);

    if (hydrated && !available) {
      const result = invalidateAuthSession({
        reason: "expired",
        returnTo: `${pathname ?? ""}${window.location.search}`
      });
      // A 401 may have invalidated the module immediately before this boundary
      // mounted. In that case no second event is emitted, so navigate here.
      if (!result.initiated) router.replace(result.loginHref);
    }

    return () => window.removeEventListener(AUTH_SESSION_INVALIDATED_EVENT, handleInvalidation);
  }, [available, hydrated, pathname, router]);

  return hydrated && available;
}

function NavItem({
  href,
  label,
  icon: Icon,
  active,
  onNavigate
}: {
  href: string;
  label: string;
  icon: typeof Gauge;
  activeRoots: readonly string[];
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      className={`app-nav-link ds-focus-ring group ${
        active
          ? "bg-surface-selected font-semibold text-brand-primary"
          : "text-foreground-muted hover:bg-surface-subtle hover:text-foreground"
      }`}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden />
      <span className="app-nav-label">{label}</span>
      <RailTooltip>{label}</RailTooltip>
    </Link>
  );
}

/**
 * Tooltip for the icon-only rail. The control's accessible name comes from
 * aria-label, so this is presentational: it must never be the only way to learn
 * what a control does.
 */
function RailTooltip({ children }: { children: React.ReactNode }) {
  return (
    <span
      aria-hidden
      className="app-rail-tooltip pointer-events-none absolute left-full z-40 ml-2 whitespace-nowrap rounded-control border border-line-default bg-surface-raised px-2.5 py-1.5 text-xs font-medium text-foreground shadow-raised"
    >
      {children}
    </span>
  );
}
