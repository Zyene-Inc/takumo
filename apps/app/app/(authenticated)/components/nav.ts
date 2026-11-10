import {
  BookOpenIcon,
  BrainIcon,
  Building2Icon,
  CalendarDaysIcon,
  ClipboardCheckIcon,
  CogIcon,
  FileInputIcon,
  FolderLockIcon,
  FoldersIcon,
  GaugeIcon,
  HistoryIcon,
  HomeIcon,
  InboxIcon,
  LayersIcon,
  LifeBuoyIcon,
  ListChecksIcon,
  type LucideIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  MicIcon,
  MonitorIcon,
  PackageIcon,
  RocketIcon,
  SlidersHorizontalIcon,
  SquareKanbanIcon,
  Trash2Icon,
  UploadIcon,
  UsersIcon,
  WrenchIcon,
} from "lucide-react";

/** Counts shown beside nav rows; filled by the layout. */
export interface Pulse {
  drafts: number;
  newSenders: number;
  posToEnter: number;
  rfqsToQuote: number;
}

export interface NavItem {
  /** Which Pulse count sits on the right of the row. */
  count?: (pulse: Pulse) => number;
  icon: LucideIcon;
  /** Paths under this prefix light the row up (defaults to url). */
  match?: string;
  title: string;
  url: string;
}

export interface NavSection {
  id: string;
  items: NavItem[];
  label: string;
}

export const TOP_ITEMS: NavItem[] = [
  { title: "Home", url: "/", icon: HomeIcon },
  { title: "Ask Takumo", url: "/ask", icon: MessageSquareIcon },
];

const LIBRARY_ITEMS: NavItem[] = [
  { title: "Company files", url: "/library", icon: FoldersIcon },
  { title: "Personal", url: "/library/personal", icon: FolderLockIcon },
  { title: "My uploads", url: "/library/mine", icon: UploadIcon },
  { title: "Trash", url: "/library/trash", icon: Trash2Icon },
];

export const sectionsFor = (libraryEnabled: boolean): NavSection[] => [
  {
    id: "quoting",
    label: "Quoting",
    items: [
      {
        title: "RFQ inbox",
        url: "/quotes",
        icon: InboxIcon,
        count: (p) => p.rfqsToQuote + p.drafts + p.newSenders,
      },
      { title: "Past quotes", url: "/quotes/history", icon: HistoryIcon },
      {
        title: "Incoming POs",
        url: "/orders/incoming",
        icon: FileInputIcon,
        count: (p) => p.posToEnter,
      },
    ],
  },
  {
    id: "schedule",
    label: "Schedule",
    items: [
      { title: "Board", url: "/schedule", icon: SquareKanbanIcon },
      {
        title: "Can we take it?",
        url: "/schedule/check",
        icon: ClipboardCheckIcon,
      },
      { title: "Bottlenecks", url: "/schedule/bottlenecks", icon: GaugeIcon },
      { title: "Calendar", url: "/schedule/calendar", icon: CalendarDaysIcon },
      { title: "Shop floor", url: "/schedule/floor", icon: MonitorIcon },
    ],
  },
  {
    id: "shop",
    label: "Shop",
    items: [
      { title: "Work centers", url: "/shop/work-centers", icon: CogIcon },
      { title: "Operators", url: "/shop/operators", icon: UsersIcon },
      { title: "Parts & routings", url: "/shop/parts", icon: WrenchIcon },
      { title: "Orders", url: "/shop/orders", icon: PackageIcon },
      { title: "Customers", url: "/shop/customers", icon: Building2Icon },
      { title: "Materials", url: "/shop/materials", icon: LayersIcon },
    ],
  },
  {
    id: "knowledge",
    label: "Knowledge",
    items: [
      ...(libraryEnabled ? LIBRARY_ITEMS : []),
      { title: "Brain", url: "/knowledge/brain", icon: BrainIcon },
      // The flat list, for shops not on the library (it opens the library otherwise).
      ...(libraryEnabled
        ? []
        : [{ title: "Sources", url: "/knowledge", icon: BookOpenIcon }]),
      { title: "Facts", url: "/knowledge/facts", icon: ListChecksIcon },
      { title: "Voice notes", url: "/knowledge/notes", icon: MicIcon },
      {
        title: "Calibration",
        url: "/knowledge/calibration",
        icon: SlidersHorizontalIcon,
      },
      { title: "Conversations", url: "/ask/history", icon: MessagesSquareIcon },
    ],
  },
  {
    id: "resources",
    label: "Resources",
    items: [
      { title: "Set up your shop", url: "/onboarding", icon: RocketIcon },
      { title: "Help", url: "/help", icon: LifeBuoyIcon },
    ],
  },
];

export const SETTINGS_TABS = [
  { title: "Team", url: "/settings/team" },
  { title: "Departments", url: "/settings/departments" },
  { title: "Integrations", url: "/settings/integrations" },
  { title: "Quoting", url: "/settings/quoting" },
  { title: "Notifications", url: "/settings/notifications" },
  { title: "Billing", url: "/settings/billing" },
];

const covers = (pathname: string, prefix: string) =>
  prefix === "/"
    ? pathname === "/"
    : pathname === prefix || pathname.startsWith(`${prefix}/`);

/**
 * The one item a path belongs to: the longest matching prefix wins, so
 * /quotes/history lights "Past quotes", not "RFQ inbox".
 */
export const activeUrl = (
  pathname: string,
  items: NavItem[]
): string | undefined =>
  items
    .filter((item) => covers(pathname, item.match ?? item.url))
    .sort((a, b) => (b.match ?? b.url).length - (a.match ?? a.url).length)[0]
    ?.url;

/** Pages that aren't in the sidebar but still get a breadcrumb. */
const OTHER_PAGES: Record<string, string> = {
  "/admin": "Admin",
  "/orders": "Orders",
  "/search": "Search",
  "/shop": "Shop overview",
};

export interface Crumb {
  href: string;
  label: string;
}

/** The header breadcrumb for a path: section, page, and "Details" below it. */
export const crumbsFor = (
  pathname: string,
  sections: NavSection[]
): Crumb[] => {
  if (covers(pathname, "/settings")) {
    const tab = SETTINGS_TABS.find((t) => covers(pathname, t.url));
    return [
      { label: "Settings", href: SETTINGS_TABS[0].url },
      ...(tab ? [{ label: tab.title, href: tab.url }] : []),
    ];
  }
  const all = [...TOP_ITEMS, ...sections.flatMap((s) => s.items)];
  const url = activeUrl(pathname, all);
  if (!url || url === "/") {
    const other = Object.keys(OTHER_PAGES).find((p) => covers(pathname, p));
    if (other) {
      return [{ label: OTHER_PAGES[other], href: other }];
    }
    return url === "/" ? [{ label: "Home", href: "/" }] : [];
  }
  const item = all.find((i) => i.url === url) as NavItem;
  const section = sections.find((s) => s.items.includes(item));
  const crumbs: Crumb[] = section
    ? [
        { label: section.label, href: section.items[0].url },
        { label: item.title, href: item.url },
      ]
    : [{ label: item.title, href: item.url }];
  if (pathname !== item.url) {
    crumbs.push({ label: "Details", href: pathname });
  }
  return crumbs;
};
