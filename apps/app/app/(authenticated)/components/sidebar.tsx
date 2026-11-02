"use client";

import type { UserOrganization } from "@repo/auth/server";
import { ModeToggle } from "@repo/design-system/components/mode-toggle";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@repo/design-system/components/ui/sidebar";
import { cn } from "@repo/design-system/lib/utils";
import {
  BrainIcon,
  CalculatorIcon,
  CalendarRangeIcon,
  ChevronRightIcon,
  ClipboardListIcon,
  FactoryIcon,
  FolderIcon,
  LifeBuoyIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  Settings2Icon,
  ShareIcon,
  Trash2Icon,
  UploadIcon,
  WrenchIcon,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Search } from "./search";
import { ShopSwitcher } from "./shop-switcher";
import { UserMenu, type UserMenuUser } from "./user-menu";

interface GlobalSidebarProperties {
  readonly children: ReactNode;
  readonly currentOrganizationId: string;
  readonly organizations: UserOrganization[];
  readonly user: UserMenuUser;
}

const data = {
  user: {
    name: "shadcn",
    email: "m@example.com",
    avatar: "/avatars/shadcn.jpg",
  },
  navMain: [
    {
      title: "Ask Takumo",
      url: "/ask",
      icon: MessageSquareIcon,
      isActive: true,
      items: [
        {
          title: "Can we take this order?",
          url: "/schedule/check",
        },
        {
          title: "History",
          url: "/ask/history",
        },
      ],
    },
    {
      title: "Quotes",
      url: "/quotes",
      icon: CalculatorIcon,
      items: [
        {
          title: "RFQ inbox",
          url: "/quotes",
        },
        {
          title: "Past quotes",
          url: "/quotes/history",
        },
        {
          title: "Incoming POs",
          url: "/orders/incoming",
        },
      ],
    },
    {
      title: "Schedule",
      url: "/schedule",
      icon: CalendarRangeIcon,
      items: [
        {
          title: "Board",
          url: "/schedule",
        },
        {
          title: "Can we take this order?",
          url: "/schedule/check",
        },
        {
          title: "Bottlenecks",
          url: "/schedule/bottlenecks",
        },
        {
          title: "Calendar",
          url: "/schedule/calendar",
        },
        {
          title: "Shop floor",
          url: "/schedule/floor",
        },
      ],
    },
    {
      title: "Shop",
      url: "/shop",
      icon: FactoryIcon,
      items: [
        {
          title: "Work centers",
          url: "/shop/work-centers",
        },
        {
          title: "Parts & routings",
          url: "/shop/parts",
        },
        {
          title: "Orders",
          url: "/shop/orders",
        },
        {
          title: "Customers",
          url: "/shop/customers",
        },
        {
          title: "Materials",
          url: "/shop/materials",
        },
      ],
    },
    {
      title: "Knowledge",
      url: "/knowledge",
      icon: BrainIcon,
      items: [
        {
          title: "Brain",
          url: "/knowledge/brain",
        },
        {
          title: "Sources",
          url: "/knowledge",
        },
        {
          title: "Facts",
          url: "/knowledge/facts",
        },
        {
          title: "Voice notes",
          url: "/knowledge/notes",
        },
        {
          title: "Calibration",
          url: "/knowledge/calibration",
        },
      ],
    },
    {
      title: "Settings",
      url: "/settings/billing",
      icon: Settings2Icon,
      items: [
        {
          title: "Team",
          url: "/settings/team",
        },
        {
          title: "Integrations",
          url: "/settings/integrations",
        },
        {
          title: "Quoting",
          url: "/settings/quoting",
        },
        {
          title: "Billing",
          url: "/settings/billing",
        },
      ],
    },
  ],
  navSecondary: [
    {
      title: "Set up your shop",
      url: "/onboarding",
      icon: UploadIcon,
    },
    {
      title: "Help",
      url: "/help",
      icon: LifeBuoyIcon,
    },
  ],
  projects: [
    {
      name: "Open orders",
      url: "/shop/orders",
      icon: ClipboardListIcon,
    },
    {
      name: "Open quotes",
      url: "/quotes",
      icon: CalculatorIcon,
    },
    {
      name: "Machines",
      url: "/shop/work-centers",
      icon: WrenchIcon,
    },
  ],
};

export const GlobalSidebar = ({
  children,
  currentOrganizationId,
  organizations,
  user,
}: GlobalSidebarProperties) => {
  const sidebar = useSidebar();

  return (
    <>
      <Sidebar variant="inset">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <div
                className={cn(
                  "overflow-hidden transition-all",
                  sidebar.open ? "" : "-mx-1"
                )}
              >
                <ShopSwitcher
                  currentOrganizationId={currentOrganizationId}
                  organizations={organizations}
                />
              </div>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <Search />
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Takumo</SidebarGroupLabel>
            <SidebarMenu>
              {data.navMain.map((item) => (
                <Collapsible
                  asChild
                  defaultOpen={item.isActive}
                  key={item.title}
                >
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild tooltip={item.title}>
                      <Link href={item.url}>
                        <item.icon />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                    {item.items?.length ? (
                      <>
                        <CollapsibleTrigger asChild>
                          <SidebarMenuAction className="data-[state=open]:rotate-90">
                            <ChevronRightIcon />
                            <span className="sr-only">Toggle</span>
                          </SidebarMenuAction>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <SidebarMenuSub>
                            {item.items?.map((subItem) => (
                              <SidebarMenuSubItem key={subItem.title}>
                                <SidebarMenuSubButton asChild>
                                  <Link href={subItem.url}>
                                    <span>{subItem.title}</span>
                                  </Link>
                                </SidebarMenuSubButton>
                              </SidebarMenuSubItem>
                            ))}
                          </SidebarMenuSub>
                        </CollapsibleContent>
                      </>
                    ) : null}
                  </SidebarMenuItem>
                </Collapsible>
              ))}
            </SidebarMenu>
          </SidebarGroup>
          <SidebarGroup className="group-data-[collapsible=icon]:hidden">
            <SidebarGroupLabel>Quick links</SidebarGroupLabel>
            <SidebarMenu>
              {data.projects.map((item) => (
                <SidebarMenuItem key={item.name}>
                  <SidebarMenuButton asChild>
                    <Link href={item.url}>
                      <item.icon />
                      <span>{item.name}</span>
                    </Link>
                  </SidebarMenuButton>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <SidebarMenuAction showOnHover>
                        <MoreHorizontalIcon />
                        <span className="sr-only">More</span>
                      </SidebarMenuAction>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      className="w-48"
                      side="bottom"
                    >
                      <DropdownMenuItem>
                        <FolderIcon className="text-muted-foreground" />
                        <span>View Project</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem>
                        <ShareIcon className="text-muted-foreground" />
                        <span>Share Project</span>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem>
                        <Trash2Icon className="text-muted-foreground" />
                        <span>Delete Project</span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </SidebarMenuItem>
              ))}
              <SidebarMenuItem>
                <SidebarMenuButton>
                  <MoreHorizontalIcon />
                  <span>More</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
          <SidebarGroup className="mt-auto">
            <SidebarGroupContent>
              <SidebarMenu>
                {data.navSecondary.map((item) => (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton asChild>
                      <Link href={item.url}>
                        <item.icon />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem className="flex items-center gap-2">
              <UserMenu user={user} />
              <div className="flex shrink-0 items-center gap-px">
                <ModeToggle />
              </div>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>{children}</SidebarInset>
    </>
  );
};
