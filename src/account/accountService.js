'use strict';
// S2-7C — account read service. Given VERIFIED token claims (never client-declared),
// assembles the /api/account/me payload: profile + active memberships + accessible
// workspaces with the account role. Reads via the injected select (service_role, RLS
// bypassed) but ALWAYS scopes to the verified user id. Returns ONLY safe fields — never
// password/hash/refresh token/service-role key/invitation token/other users' platform
// roles/operational workspace data.

// deps: { selectProfile(userId), selectMemberships(userId) } — each async → array of rows.
function createAccountService(deps) {
  const selectProfile = deps.selectProfile;
  const selectMemberships = deps.selectMemberships;
  if (typeof selectProfile !== 'function' || typeof selectMemberships !== 'function') {
    throw new Error('createAccountService: selectProfile and selectMemberships required');
  }

  return async function getAccountMe(claims) {
    const userId = claims && claims.sub;
    if (!userId) throw new Error('getAccountMe: verified claims.sub required');

    const profiles = await selectProfile(userId);
    const profile = Array.isArray(profiles) && profiles[0] ? profiles[0] : null;

    const rows = (await selectMemberships(userId)) || [];
    // Active memberships only. Each row is a membership joined to its workspace.
    const memberships = (Array.isArray(rows) ? rows : [])
      .filter(r => r && r.status === 'active')
      .map(r => Object.freeze({
        workspaceId:   r.workspace_id,
        workspaceSlug: r.workspace_slug ?? (r.workspaces && r.workspaces.slug) ?? null,
        workspaceName: r.workspace_name ?? (r.workspaces && r.workspaces.display_name) ?? null,
        lifecycleStatus:  r.workspace_lifecycle ?? (r.workspaces && r.workspaces.lifecycle_status) ?? null,
        commercialStatus: r.workspace_commercial ?? (r.workspaces && r.workspaces.commercial_status) ?? null,
        role:   r.role,
        status: r.status,
      }));

    return Object.freeze({
      userId,
      email: claims.email || (profile && profile.email) || null,
      emailVerified: claims.emailVerified === true,
      displayName: profile ? (profile.display_name ?? null) : null,
      memberships,                                   // [] when none
      workspaces: memberships.map(m => m.workspaceId), // accessible workspace ids
    });
  };
}

module.exports = { createAccountService };
