import { settingsProxy } from "@/lib/settings-proxy";

export const { GET, PUT, DELETE } = settingsProxy<{
  id: string;
  repositoryKey: string;
}>(
  ({ id, repositoryKey }) =>
    `/integration-settings/${encodeURIComponent(id)}/repositories/${encodeURIComponent(repositoryKey)}`,
  "repository integration settings"
);
