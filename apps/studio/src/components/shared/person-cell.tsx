import Link from "next/link";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { personInitials, personLabel } from "@/lib/format";
import type { IdentityView, ProfileView } from "@/lib/types";

interface Person {
  identity: IdentityView;
  profile?: ProfileView;
}

/** The person's picture, or their initials when the provider gave none (or it fails to load). The URL is shown as-is, never fetched by Studio's server. */
export function PersonAvatar({ person, size = "default" }: { person: Person; size?: "default" | "sm" | "lg" }) {
  return (
    <Avatar size={size}>
      {person.profile?.avatarUrl && <AvatarImage src={person.profile.avatarUrl} alt="" referrerPolicy="no-referrer" />}
      <AvatarFallback>{personInitials(person)}</AvatarFallback>
    </Avatar>
  );
}

/**
 * Who a member is: avatar, name (or e-mail, or the id when nothing is stored) and, underneath, the e-mail and the provider's id,
 * so two people with the same name can still be told apart.
 */
export function PersonCell({ person, href, via }: { person: Person; href?: string; via: string }) {
  const label = personLabel(person);
  const { displayName, email } = person.profile ?? {};
  const secondary = displayName !== undefined && email !== undefined ? email : undefined;
  return (
    <div className="flex min-w-0 items-center gap-3">
      <PersonAvatar person={person} />
      <div className="flex min-w-0 flex-col">
        {href ? (
          <Link href={href} className="truncate font-medium underline-offset-4 hover:text-primary hover:underline">
            {label}
          </Link>
        ) : (
          <span className="truncate font-medium">{label}</span>
        )}
        {secondary && <span className="truncate text-xs text-muted-foreground">{secondary}</span>}
        <span className="truncate text-xs text-muted-foreground" title={person.identity.subject}>
          {displayName === undefined && email === undefined ? via : `${via} · ${person.identity.subject}`}
        </span>
      </div>
    </div>
  );
}
