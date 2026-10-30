import { listUserOrganizations, withAuth } from "@repo/auth/server";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import type { Metadata } from "next";
import { createShop, switchShop } from "../actions/auth";

export const metadata: Metadata = { title: "Your shop · Takumo" };

// First stop for a signed-in user with no active shop (organization).
const CreateShopPage = async () => {
  const { user } = await withAuth({ ensureSignedIn: true });
  const organizations = await listUserOrganizations(user.id);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 px-4">
      <div>
        <p className="text-muted-foreground text-sm">Takumo 匠</p>
        <h1 className="mt-1 font-semibold text-2xl">
          {organizations.length > 0 ? "Choose your shop" : "Create your shop"}
        </h1>
        <p className="mt-2 text-muted-foreground text-sm">
          Everything in Takumo (machines, orders, quotes, knowledge) belongs to
          a shop. Invite your team to it later.
        </p>
      </div>

      {organizations.length > 0 && (
        <ul className="flex flex-col gap-2">
          {organizations.map((organization) => (
            <li key={organization.id}>
              <form action={switchShop.bind(null, organization.id)}>
                <Button className="w-full justify-between" variant="outline">
                  <span>{organization.name}</span>
                  <span className="text-muted-foreground text-xs">
                    {organization.role}
                  </span>
                </Button>
              </form>
            </li>
          ))}
        </ul>
      )}

      <form action={createShop} className="flex flex-col gap-3">
        <Label htmlFor="name">
          {organizations.length > 0 ? "Or create a new shop" : "Shop name"}
        </Label>
        <Input
          id="name"
          maxLength={80}
          name="name"
          placeholder="Acme Precision"
          required
        />
        <Button type="submit">Create shop</Button>
      </form>
    </main>
  );
};

export default CreateShopPage;
