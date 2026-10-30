"use client";

import type { UserOrganization } from "@repo/auth/server";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { SidebarMenuButton } from "@repo/design-system/components/ui/sidebar";
import {
  CheckIcon,
  ChevronsUpDownIcon,
  FactoryIcon,
  PlusIcon,
} from "lucide-react";
import Link from "next/link";
import { useTransition } from "react";
import { switchShop } from "../../actions/auth";

interface ShopSwitcherProperties {
  readonly currentOrganizationId: string;
  readonly organizations: UserOrganization[];
}

export const ShopSwitcher = ({
  currentOrganizationId,
  organizations,
}: ShopSwitcherProperties) => {
  const [isPending, startTransition] = useTransition();
  const current = organizations.find((org) => org.id === currentOrganizationId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton disabled={isPending} size="lg">
          <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <FactoryIcon className="size-4" />
          </div>
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-medium">
              {current?.name ?? "Your shop"}
            </span>
            <span className="truncate text-muted-foreground text-xs">
              {current?.role ?? "member"}
            </span>
          </div>
          <ChevronsUpDownIcon className="ml-auto size-4" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-muted-foreground text-xs">
          Shops
        </DropdownMenuLabel>
        {organizations.map((organization) => (
          <DropdownMenuItem
            key={organization.id}
            onSelect={() => {
              if (organization.id !== currentOrganizationId) {
                startTransition(() => switchShop(organization.id));
              }
            }}
          >
            <span className="truncate">{organization.name}</span>
            {organization.id === currentOrganizationId && (
              <CheckIcon className="ml-auto size-4" />
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/create-shop">
            <PlusIcon className="size-4" />
            Create a shop
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
