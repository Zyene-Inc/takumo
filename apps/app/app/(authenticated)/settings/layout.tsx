import type { ReactNode } from "react";
import { SettingsTabs } from "./components/tabs";

const SettingsLayout = ({ children }: { children: ReactNode }) => (
  <>
    <SettingsTabs />
    {children}
  </>
);

export default SettingsLayout;
