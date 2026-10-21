import { cronJobs } from "incibase/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("heartbeat", { hours: 1 }, internal.messages.bumpCount, { key: "heartbeats" });
export default crons;
