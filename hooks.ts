import { dirname, resolve } from "node:path";

type Request = { url: string; cookies?: Record<string, string> };
type Response = { statusCode: number; end: (body: string) => void };
type NextFunction = () => void;
type RouterLayer = { name?: string };

const Layer = require("router/lib/layer") as new (
  path: string,
  options: { strict: boolean; end: boolean },
  fn: (req: Request, res: Response, next: NextFunction) => void | Promise<void>,
) => RouterLayer;

const { issueCookie } = require(resolve(dirname(require.resolve("n8n")), "auth/jwt")) as {
  issueCookie: (res: Response, user: { role: { slug: string }; mfaEnabled?: boolean }) => void;
};

const AUTH_COOKIE_NAME = "n8n-auth";

type EndpointsConfig = {
  health: string;
  rest: string;
  webhook: string;
  webhookTest: string;
  webhookWaiting: string;
  form: string;
  formTest: string;
  formWaiting: string;
  mcp: string;
  mcpTest: string;
};

type N8nServer = {
  app: {
    router: { stack: Array<{ name?: string }> };
  };
  globalConfig: { endpoints: EndpointsConfig };
};

type HookContext = {
  dbCollections: {
    User: {
      findOne: (opts: {
        where: { email: string };
        relations: string[];
      }) => Promise<{ role: { slug: string }; mfaEnabled?: boolean } | null>;
    };
  };
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSkipPathRegex(endpoints: EndpointsConfig): RegExp {
  const segments = [
    "assets",
    "icons",
    "schemas",
    endpoints.health.replace(/^\//, "") || "healthz",
    endpoints.webhook,
    endpoints.webhookTest,
    endpoints.webhookWaiting,
    endpoints.form,
    endpoints.formTest,
    endpoints.formWaiting,
    endpoints.mcp,
    endpoints.mcpTest,
    `${endpoints.rest}/oauth1-credential`,
    `${endpoints.rest}/oauth2-credential`,
  ];
  return new RegExp(`^/(?:${segments.map(escapeRegex).join("|")})`);
}

module.exports = {
  n8n: {
    ready: [
      async function (
        this: HookContext,
        server: N8nServer,
        config: { get: (key: string, fallback?: boolean) => boolean },
      ) {
        const { app } = server;
        const ignoreAuthRegexp = buildSkipPathRegex(server.globalConfig.endpoints);
        const stack = app.router.stack as RouterLayer[];
        const index = stack.findIndex((l) => l.name === "cookieParser");
        if (index < 0) {
          throw new Error("cookieParser middleware not found; cannot install auto-login hook");
        }

        stack.splice(
          index + 1,
          0,
          new Layer("/", { strict: false, end: false }, async (req, res, next) => {
            if (process.env.N8N_DIET_AUTO_LOGIN === "false") return next();
            if (ignoreAuthRegexp.test(req.url)) return next();
            if (!config.get("userManagement.isInstanceOwnerSetUp", false)) return next();
            if (req.cookies?.[AUTH_COOKIE_NAME]) return next();

            const email = process.env.N8N_INSTANCE_OWNER_EMAIL;
            if (!email) return next();

            const user = await this.dbCollections.User.findOne({
              where: { email },
              relations: ["role"],
            });
            if (!user) {
              res.statusCode = 401;
              res.end(`Instance owner ${email} not found. Check N8N_INSTANCE_OWNER_* env vars.`);
              return;
            }

            issueCookie(res, user);
            return next();
          }),
        );
      },
    ],
  },
};
