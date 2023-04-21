import type { Workspace, WorkspaceInstance } from "@prisma/client";
import {
  proxyActivities,
  uuid4,
  executeChild,
  startChild,
  sleep,
  continueAsNew,
  ParentClosePolicy,
} from "@temporalio/workflow";

import type { Activities } from "../activities/list";

import { retryWorkflow } from "~/temporal/utils";

const {
  createWorkspace,
  startWorkspace,
  stopWorkspace,
  getWorkspaceInstanceStatus,
  reservePrebuildEvent,
  removePrebuildEventReservation,
} = proxyActivities<Activities>({
  // Setting this too low may cause activities such as buildfs to fail.
  // Buildfs in particular waits on a file lock to obtain a lock on its
  // project filesystem, so if several buildfs activities for the same project
  // are running at the same time, it may take a long time for all of them
  // to finish.
  startToCloseTimeout: "24 hours",
  retry: {
    maximumAttempts: 1,
  },
});

const { cleanUpWorkspaceInstanceLocal } = proxyActivities<Activities>({
  // Setting this too low may cause activities such as buildfs to fail.
  // Buildfs in particular waits on a file lock to obtain a lock on its
  // project filesystem, so if several buildfs activities for the same project
  // are running at the same time, it may take a long time for all of them
  // to finish.
  startToCloseTimeout: "24 hours",
  heartbeatTimeout: "20 seconds",
  retry: {
    maximumAttempts: 1,
  },
});

export async function runCreateWorkspace(args: {
  name: string;
  prebuildEventId: bigint;
  gitBranchId: bigint;
  userId: bigint;
  externalId: string;
  startWorkspace: boolean;
}): Promise<Workspace> {
  const workspace = await (async () => {
    const reservationExternalId = uuid4();
    const now = Date.now();
    try {
      const fifteenMinutes = 1000 * 60 * 15;
      await reservePrebuildEvent({
        prebuildEventId: args.prebuildEventId,
        reservationType: "PREBUILD_EVENT_RESERVATION_TYPE_CREATE_WORKSPACE",
        reservationExternalId,
        validUntil: new Date(now + fifteenMinutes),
      });
      return await createWorkspace(args);
    } finally {
      await retryWorkflow(() => removePrebuildEventReservation(reservationExternalId), {
        maxRetries: 5,
        retryIntervalMs: 1000,
      });
    }
  })();
  if (args.startWorkspace) {
    await startChild(runStartWorkspace, {
      args: [workspace.id],
      workflowId: uuid4(),
      parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
    });
  }
  return workspace;
}

async function cleanUpAfterWorkspaceError(
  workspaceId: bigint,
  vmInstanceId?: string,
): Promise<void> {
  await retryWorkflow(() => cleanUpWorkspaceInstanceLocal({ workspaceId, vmInstanceId }), {
    maxRetries: 8,
    retryIntervalMs: 1000,
    isExponential: true,
  });
}

export async function runStartWorkspace(
  workspaceId: bigint,
): Promise<{ workspaceInstance: WorkspaceInstance; status: "started" | "found" }> {
  const vmInstanceId = uuid4();
  const result = await startWorkspace({ workspaceId, vmInstanceId }).catch(async (err) => {
    await cleanUpAfterWorkspaceError(workspaceId, vmInstanceId);
    throw err;
  });
  if (result.status === "started") {
    await startChild(monitorWorkspaceInstance, {
      args: [workspaceId, result.workspaceInstance.id],
      workflowId: result.workspaceInstance.monitoringWorkflowId,
      parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
    });
  }
  return result;
}

export async function runStopWorkspace(workspaceId: bigint): Promise<void> {
  return await stopWorkspace(workspaceId).catch(async (err) => {
    await cleanUpAfterWorkspaceError(workspaceId);
    throw err;
  });
}

export async function monitorWorkspaceInstance(
  workspaceId: bigint,
  workspaceInstanceId: bigint,
): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    await sleep(5000);
    const status = await retryWorkflow(() => getWorkspaceInstanceStatus(workspaceInstanceId), {
      maxRetries: 10,
      retryIntervalMs: 1000,
    });
    if (status === "removed") {
      return;
    }
    if (status !== "on") {
      await executeChild(runStopWorkspace, { args: [workspaceId] });
      return;
    }
  }
  await continueAsNew<typeof monitorWorkspaceInstance>(workspaceId, workspaceInstanceId);
}
