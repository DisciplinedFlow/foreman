export interface ProjectRef { projectId: string }
export interface WorkItemRef { workItemId: string }
export interface Schedule { startAt?: string; targetAt?: string; iterationId?: string }
export interface NewWorkItem { title: string; intent?: string; kind?: "epic"|"story"|"task"|"bug"|"chore"; priority?: number; acceptance?: string[]; parent?: WorkItemRef; repo?: string }
export interface WorkItem extends NewWorkItem, WorkItemRef { status: string; ghIssueNumber?: number; ghRepo?: string }
export interface RunStatus { state: "queued"|"in_progress"|"completed"; summary?: string; conclusion?: "success"|"failure"|"cancelled"; detailsUrl?: string; headSha?: string }
export type BackboneEvent =
  | { kind: "work_item_changed"; item: WorkItem }
  | { kind: "dependency_changed"; blocked: WorkItemRef; blocker: WorkItemRef; removed: boolean }
  | { kind: "schedule_changed"; item: WorkItemRef; schedule: Schedule };
export type Unsubscribe = () => void;

export interface Backbone {
  listWorkItems(project: ProjectRef, since?: Date): Promise<WorkItem[]>;
  createWorkItem(project: ProjectRef, item: NewWorkItem): Promise<WorkItem>;
  updateSchedule(item: WorkItemRef, s: Schedule): Promise<void>;
  linkParent(child: WorkItemRef, parent: WorkItemRef): Promise<void>;
  addDependency(blocked: WorkItemRef, blocker: WorkItemRef): Promise<void>;
  reportRun(item: WorkItemRef, run: RunStatus): Promise<void>;
  subscribe(handler: (e: BackboneEvent) => void): Unsubscribe;
}
