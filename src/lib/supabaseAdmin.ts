import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import type { Request } from "express";

export class HttpAuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = "HttpAuthError";
    this.status = status;
  }
}

export interface UserProfile {
  id: string;
  full_name: string;
  email: string;
  role: "participant" | "organizer" | "admin";
  organizer_status: string;
  is_suspended: boolean;
}

export interface AuthenticatedContext {
  user: User;
  profile: UserProfile;
  adminClient: SupabaseClient;
}

export function isPlaceholderEnv(value: string | undefined): boolean {
  if (!value || !value.trim()) return true;
  return (
    value.includes("your-project-ref") ||
    value.includes("your-supabase-service-role-key")
  );
}

let cachedAdmin: { url: string; key: string; client: SupabaseClient } | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  const url = process.env.SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (isPlaceholderEnv(url) || isPlaceholderEnv(serviceKey)) {
    throw new Error(
      "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing or still set to a placeholder in backend/.env.",
    );
  }

  if (cachedAdmin && cachedAdmin.url === url && cachedAdmin.key === serviceKey) {
    return cachedAdmin.client;
  }

  const client = createClient(url!, serviceKey!, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  cachedAdmin = { url: url!, key: serviceKey!, client };
  return client;
}

/** Extracts Bearer JWT from request headers, verifies it via Supabase Auth, and resolves the non-suspended profile. */
export async function requireAuthenticatedUser(
  req: Request,
): Promise<AuthenticatedContext> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new HttpAuthError("Missing or invalid Authorization header.", 401);
  }

  const jwt = authHeader.slice("Bearer ".length).trim();
  const adminClient = getSupabaseAdmin();

  const { data: userData, error: userError } = await adminClient.auth.getUser(jwt);
  if (userError || !userData?.user) {
    throw new HttpAuthError("Invalid or expired session token.", 401);
  }

  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("id, full_name, email, role, organizer_status, is_suspended")
    .eq("id", userData.user.id)
    .single();

  if (profileError || !profile) {
    throw new HttpAuthError("User profile could not be resolved.", 403);
  }

  if (profile.is_suspended) {
    throw new HttpAuthError(
      "Your account has been suspended by an administrator.",
      403,
    );
  }

  return { user: userData.user, profile: profile as UserProfile, adminClient };
}

