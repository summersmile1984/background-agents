import { describe, expect, it } from "vitest";
import { buildVercelBootstrapScript } from "./bootstrap";

describe("buildVercelBootstrapScript", () => {
  it("makes the pinned browser runtime a mandatory image-build gate", () => {
    const script = buildVercelBootstrapScript();

    expect(script).toContain('AGENT_BROWSER_VERSION="0.21.2"');
    expect(script).toContain('agent-browser@"$AGENT_BROWSER_VERSION"');
    expect(script).toContain("agent-browser install\nagent-browser --version");
    expect(script).not.toContain("agent-browser install || true");
  });

  it.each(["fluxbox.tar.xz", "libvncserver.tar.gz", "x11vnc.tar.gz", "novnc.tar.gz"])(
    "verifies %s before extraction",
    (archive) => {
      const script = buildVercelBootstrapScript();
      const verification = `/${archive}" | sha256sum -c -`;
      const extraction = `tar -x`;

      expect(script).toContain(verification);
      expect(script.indexOf(verification)).toBeLessThan(
        script.indexOf(extraction, script.indexOf(verification))
      );
    }
  );
});
