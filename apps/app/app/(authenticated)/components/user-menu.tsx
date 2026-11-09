"use client";

// The user menu at the foot of the sidebar. Styled after Warmbly's UserNav
// (https://github.com/warmbly/warmbly, Apache-2.0), modified for Takumo.

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { LifeBuoyIcon, LogOutIcon, SettingsIcon } from "lucide-react";
import Link from "next/link";
import { signOutAction } from "../../actions/auth";
import { initials } from "./shop-switcher";

export interface UserMenuUser {
  email: string;
  imageUrl: string | null;
  name: string;
}

interface UserMenuProperties {
  readonly user: UserMenuUser;
}

export const UserMenu = ({ user }: UserMenuProperties) => (
  <DropdownMenu>
    <DropdownMenuTrigger className="mx-3 my-2 flex w-[calc(100%-1.5rem)] cursor-pointer items-center gap-2.5 rounded-md py-1 pr-1.5 pl-0.5 text-left outline-none transition-colors hover:bg-slate-200/40">
      <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-slate-900">
        {user.imageUrl ? (
          // biome-ignore lint/performance/noImgElement: a remote avatar the size of an icon
          <img
            alt=""
            className="size-full object-cover"
            height={28}
            src={user.imageUrl}
            width={28}
          />
        ) : (
          <span className="font-medium text-[11px] text-white leading-none">
            {initials(user.name)}
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-slate-900">
          {user.name}
        </span>
        <span className="block truncate text-[10.5px] text-slate-500">
          {user.email}
        </span>
      </span>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-58" side="top">
      <div className="px-3 py-2">
        <div className="truncate font-medium text-[12.5px] text-slate-900">
          {user.name}
        </div>
        <div className="truncate font-mono text-[11px] text-slate-400">
          {user.email}
        </div>
      </div>
      <DropdownMenuSeparator />
      <DropdownMenuItem asChild>
        <Link href="/settings/team">
          <SettingsIcon className="size-3 text-slate-400" />
          Settings
        </Link>
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <Link href="/help">
          <LifeBuoyIcon className="size-3 text-slate-400" />
          Help
        </Link>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        className="text-red-600 focus:bg-red-50 focus:text-red-600"
        onSelect={() => signOutAction()}
      >
        <LogOutIcon className="size-3 text-red-500" />
        Sign out
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);
