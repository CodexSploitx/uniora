import { WebhooksView } from "@/components/webhooks/webhooks-view";
import { getWebhooksPage } from "@/lib/queries";
import { isReadOnly } from "@/lib/session";

export default async function WebhooksPage(props: PageProps<"/webhooks">) {
  const searchParams = await props.searchParams;
  const after = Array.isArray(searchParams.after) ? searchParams.after[0] : searchParams.after;
  const page = await getWebhooksPage({ cursor: after });
  return <WebhooksView page={page} readOnly={isReadOnly()} />;
}
