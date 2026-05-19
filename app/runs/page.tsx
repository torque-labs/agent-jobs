import { redirect } from "next/navigation";

/**
 * Bare /runs has no first-class index — the kanban board is the canonical
 * "all runs" view. Redirect so deep links from emails/Slack don't 404.
 */
export default function RunsIndexPage(): never {
  redirect("/kanban");
}
