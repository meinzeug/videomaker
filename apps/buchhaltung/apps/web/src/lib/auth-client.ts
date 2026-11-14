import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";
import { appPath } from "./app-path.ts";

export const authClient = createAuthClient({ basePath: appPath("/api/auth"), plugins: [passkeyClient()] });
