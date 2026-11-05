"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { Switch } from "@repo/design-system/components/ui/switch";
import { useMemo, useState, useTransition } from "react";
import { type PrefsForm, saveNotifyPrefs } from "./actions";

const COMMON_ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Toronto",
  "America/Mexico_City",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Kolkata",
];

const toggle = (list: string[], key: string, on: boolean) =>
  on ? list.filter((k) => k !== key) : [...new Set([...list, key])];

export const NotificationsForm = ({
  initial,
  sections,
  alerts,
}: {
  alerts: { key: string; title: string }[];
  initial: PrefsForm;
  sections: { hint: string; key: string; title: string }[];
}) => {
  const [v, setV] = useState(initial);
  const [message, setMessage] = useState<{
    error: boolean;
    text: string;
  } | null>(null);
  const [pending, start] = useTransition();
  const browserZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return null;
    }
  }, []);
  const zones = useMemo(
    () => [
      ...new Set([
        v.timeZone,
        ...(browserZone ? [browserZone] : []),
        ...COMMON_ZONES,
      ]),
    ],
    [v.timeZone, browserZone]
  );

  const save = () =>
    start(async () => {
      const r = await saveNotifyPrefs(v as PrefsForm);
      setMessage(
        r.ok ? { error: false, text: "Saved." } : { error: true, text: r.error }
      );
    });

  return (
    <div className="grid max-w-3xl gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Morning brief</CardTitle>
          <CardDescription>
            One email on weekdays with what needs you today. It only has the
            parts with something in them, and isn't sent when there's nothing.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          {sections.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Your role doesn't get a morning brief.
            </p>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <Switch
                  checked={v.briefOn}
                  id="brief-on"
                  onCheckedChange={(on) => setV({ ...v, briefOn: on })}
                />
                <Label htmlFor="brief-on">Send me the morning brief</Label>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="brief-time">Time</Label>
                  <Input
                    disabled={!v.briefOn}
                    id="brief-time"
                    onChange={(e) => setV({ ...v, briefTime: e.target.value })}
                    step={900}
                    type="time"
                    value={v.briefTime}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="brief-zone">Time zone</Label>
                  <select
                    className="h-9 rounded-md border bg-transparent px-3 text-sm"
                    disabled={!v.briefOn}
                    id="brief-zone"
                    onChange={(e) => setV({ ...v, timeZone: e.target.value })}
                    value={v.timeZone}
                  >
                    {zones.map((z) => (
                      <option key={z} value={z}>
                        {z.replace(/_/g, " ")}
                        {z === browserZone ? " (this device)" : ""}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid gap-3">
                <p className="font-medium text-sm">What's in it</p>
                {sections.map((s) => (
                  <div className="flex items-start gap-3" key={s.key}>
                    <Checkbox
                      checked={!v.briefOff.includes(s.key as never)}
                      disabled={!v.briefOn}
                      id={`section-${s.key}`}
                      onCheckedChange={(on) =>
                        setV({
                          ...v,
                          briefOff: toggle(
                            v.briefOff,
                            s.key,
                            on === true
                          ) as PrefsForm["briefOff"],
                        })
                      }
                    />
                    <div className="grid gap-0.5">
                      <Label htmlFor={`section-${s.key}`}>{s.title}</Label>
                      <p className="text-muted-foreground text-xs">{s.hint}</p>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Alerts</CardTitle>
          <CardDescription>
            An email within 15 minutes when something changes that you can act
            on. At most one an hour of each kind; more than one thing in that
            hour comes together.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {alerts.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Your role doesn't get alerts.
            </p>
          ) : (
            alerts.map((a) => (
              <div className="flex items-center gap-3" key={a.key}>
                <Checkbox
                  checked={!v.alertsOff.includes(a.key as never)}
                  id={`alert-${a.key}`}
                  onCheckedChange={(on) =>
                    setV({
                      ...v,
                      alertsOff: toggle(
                        v.alertsOff,
                        a.key,
                        on === true
                      ) as PrefsForm["alertsOff"],
                    })
                  }
                />
                <Label htmlFor={`alert-${a.key}`}>{a.title}</Label>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button disabled={pending} onClick={save}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {message && (
          <p className={message.error ? "text-destructive text-sm" : "text-sm"}>
            {message.text}
          </p>
        )}
      </div>
    </div>
  );
};
