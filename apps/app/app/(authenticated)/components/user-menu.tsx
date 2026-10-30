"use client";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { LogOutIcon } from "lucide-react";
import { signOutAction } from "../../actions/auth";

export interface UserMenuUser {
  email: string;
  imageUrl: string | null;
  name: string;
}

interface UserMenuProperties {
  readonly user: UserMenuUser;
}

const WHITESPACE = /\s+/;

const initials = (name: string) =>
  name
    .split(WHITESPACE)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

export const UserMenu = ({ user }: UserMenuProperties) => (
  <DropdownMenu>
    <DropdownMenuTrigger className="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left text-sm hover:bg-sidebar-accent">
      <Avatar className="size-7">
        {user.imageUrl && <AvatarImage alt={user.name} src={user.imageUrl} />}
        <AvatarFallback>{initials(user.name)}</AvatarFallback>
      </Avatar>
      <span className="truncate">{user.name}</span>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-56" side="top">
      <DropdownMenuLabel className="font-normal">
        <p className="truncate font-medium">{user.name}</p>
        <p className="truncate text-muted-foreground text-xs">{user.email}</p>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => signOutAction()}>
        <LogOutIcon className="size-4" />
        Sign out
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);
