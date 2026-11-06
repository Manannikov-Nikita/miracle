import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { GitStatus } from "../shared/project-git.js";
import { ProjectGit } from "./project-git.js";
import { problem, type ProjectStore } from "./project-store.js";

export function registerProjectGitRoutes(
  app: FastifyInstance,
  store: ProjectStore,
  need: (req: FastifyRequest) => void,
) {
  const assertCanMutate = () => {
    if (store.activeTurn())
      throw problem(
        409,
        "Дождитесь завершения работы агента перед операцией Git",
        "GIT_AGENT_ACTIVE",
      );
  };
  const git = new ProjectGit(store.context, { assertCanMutate });
  const revision = z.string().regex(/^[0-9a-f]{64}$/);
  const publish = (
    action: "create_branch" | "switch" | "commit",
    status: GitStatus,
  ) => {
    store.publish("git.changed", undefined, {
      action,
      head: status.head,
      branch: status.branch,
      revision: status.revision,
    });
    return status;
  };
  app.get("/api/project/git", async (req) => {
    need(req);
    const status = await git.status();
    if (status.canMutate && store.activeTurn()) {
      status.canMutate = false;
      status.mutationBlockedReason =
        "Дождитесь завершения работы агента перед операцией Git";
    }
    return status;
  });
  app.get("/api/project/git/diff", async (req) => {
    need(req);
    const { path } = z
      .object({ path: z.string().min(1).max(4096) })
      .parse(req.query);
    return git.diff(path);
  });
  app.post("/api/project/git/branches", async (req) => {
    need(req);
    const input = z
      .object({ name: z.string().min(1).max(255), revision })
      .parse(req.body);
    return publish("create_branch", await git.createBranch(input));
  });
  app.post("/api/project/git/switch", async (req) => {
    need(req);
    const input = z
      .object({ branch: z.string().min(1).max(255), revision })
      .parse(req.body);
    return publish("switch", await git.switchBranch(input));
  });
  app.post("/api/project/git/commit", async (req) => {
    need(req);
    const input = z
      .object({
        paths: z.array(z.string().min(1).max(4096)).min(1).max(1000),
        message: z.string().trim().min(1).max(20_000),
        revision,
      })
      .parse(req.body);
    return publish("commit", await git.commit(input));
  });
}
