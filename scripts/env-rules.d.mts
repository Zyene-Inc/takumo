export interface Rule {
  check?: (value: string) => string | null;
  prod?: (value: string) => string | null;
  skip?: (env: Record<string, string | undefined>) => boolean;
  why: string;
}
export interface Service {
  label: string;
  recommended: Record<string, Rule>;
  required: Record<string, Rule>;
}
export const SERVICES: Record<"app" | "web", Service>;
export const checkService: (
  service: Service,
  env: Record<string, string | undefined>,
  options?: { production?: boolean }
) => {
  level: "required" | "recommended";
  name: string;
  problem: string;
  why: string;
}[];
