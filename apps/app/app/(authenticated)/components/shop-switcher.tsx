"use client";

// The shop picker in the header. Styled after Warmbly's org switcher
// (https://github.com/warmbly/warmbly, Apache-2.0), modified for Takumo:
// a slim row with a monogram tile, the shop's name and a chevron.

import type { UserOrganization } from "@repo/auth/server";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useTransition } from "react";
import { switchShop } from "../../actions/auth";

interface ShopSwitcherProperties {
  readonly currentOrganizationId: string;
  readonly organizations: UserOrganization[];
}

const WHITESPACE = /\s+/;

export const initials = (name: string) =>
  name
    .split(WHITESPACE)
    .filter(Boolean)
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

const Monogram = ({ name, small }: { name: string; small?: boolean }) => (
  <span
    className={`flex shrink-0 items-center justify-center rounded-md bg-slate-900 ring-1 ring-slate-200 ${small ? "size-5" : "size-6"}`}
  >
    <span
      className={`font-bold text-white leading-none tracking-tight ${small ? "text-[9px]" : "text-[10px]"}`}
    >
      {initials(name)}
    </span>
  </span>
);

export const ShopSwitcher = ({
  currentOrganizationId,
  organizations,
}: ShopSwitcherProperties) => {
  const [isPending, startTransition] = useTransition();
  const current = organizations.find((org) => org.id === currentOrganizationId);
  const name = current?.name ?? "Your shop";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="group flex h-8 w-full items-center gap-2 rounded-md pr-2 pl-1 text-left outline-none transition-colors hover:bg-slate-200/60 disabled:opacity-60"
        disabled={isPending}
      >
        <Monogram name={name} />
        <span className="min-w-0 flex-1 truncate font-medium text-[12.5px] text-slate-900">
          {name}
        </span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-slate-400 transition-colors group-hover:text-slate-700" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-58">
        <DropdownMenuLabel>Shops</DropdownMenuLabel>
        {organizations.map((organization) => {
          const selected = organization.id === currentOrganizationId;
          return (
            <DropdownMenuItem
              className={selected ? "font-medium text-slate-900" : undefined}
              key={organization.id}
              onSelect={() => {
                if (!selected) {
                  startTransition(() => switchShop(organization.id));
                }
              }}
            >
              <Monogram name={organization.name} small />
              <span className="flex-1 truncate">{organization.name}</span>
              {selected && (
                <span className="shrink-0 text-[10px] text-sky-600">●</span>
              )}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/create-shop">
            <PlusIcon className="size-3 text-slate-400" />
            Create a shop
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
