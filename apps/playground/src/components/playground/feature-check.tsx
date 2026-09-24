"use client";

import { IconSparkles } from "@tabler/icons-react";
import { Feature, useFeature } from "@uniora/react";
import { Badge } from "@/components/reui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface FeatureCheckProps {
  feature: string;
  label: string;
  description: string;
}

/** Same pattern as `PermissionCheck`, for organization-level features instead of permissions. */
export function FeatureCheck({ feature, label, description }: FeatureCheckProps) {
  const enabled = useFeature(feature);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          {label}
          <Badge variant={enabled ? "info-light" : "outline"}>{enabled ? "Enabled" : "Disabled"}</Badge>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Feature
          feature={feature}
          fallback={<p className="text-sm text-muted-foreground">Not available for this organization.</p>}
        >
          <p className="flex items-center gap-1.5 text-sm text-info-foreground">
            <IconSparkles className="size-4" /> This panel is live.
          </p>
        </Feature>
      </CardContent>
    </Card>
  );
}
