'use strict';
// S2-7C — account read service. Given VERIFIED token claims (never client-declared),
// assembles the /api/account/me payload: profile + active memberships + accessible
// workspaces with the account role. Reads via the injected select (service_role, RLS
// bypassed) but ALWAYS scopes to the verified user id. Returns ONLY safe fields — never
// password/hash/refresh token/service-role key/invitation token/other users' platform
// roles/operational workspace data.

// deps: { selectProfile(userId), selectMemberships(userId) } — each async → array of rows.
//   The memberships select MUST include the joined workspace's
//   `owner_pin_onboarding_completed_at` so the payload can carry a SERVER-DERIVED
//   `adminPinSetupRequired`. This is deliberately independent of the operational actor's
//   pin_hash: the legacy owner actor already has a PIN, so a freshly claimed workspace
//   still requires onboarding until the marker is set.
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
    // S2-7D: adminPinRequired is derived from the workspace onboarding MARKER, not the
    // actor pin_hash. For an ACTIVE workspace the account OWNS, PIN setup is required while
    // `owner_pin_onboarding_completed_at` is null. Non-owner / inactive → null (n/a).
    let anyPinRequired = false;
    const memberships = (Array.isArray(rows) ? rows : [])
      .filter(r => r && r.status === 'active')
      .map(r => {
        const ws = r.workspaces || {};
        const lifecycleStatus = r.workspace_lifecycle ?? ws.lifecycle_status ?? null;
        const onboardingAt = r.owner_pin_onboarding_completed_at
          ?? ws.owner_pin_onboarding_completed_at ?? null;
        const isOwner = r.role === 'workspace_owner';
        let adminPinRequired = null;
        if (isOwner && lifecycleStatus === 'active') {
          adminPinRequired = onboardingAt == null;
          if (adminPinRequired) anyPinRequired = true;
        }
        return Object.freeze({
          workspaceId:   r.workspace_id,
          workspaceSlug: r.workspace_slug ?? ws.slug ?? null,
          workspaceName: r.workspace_name ?? ws.display_name ?? null,
          lifecycleStatus,
          commercialStatus: r.workspace_commercial ?? ws.commercial_status ?? null,
          role:   r.role,
          status: r.status,
          adminPinRequired,
        });
      });

    return Object.freeze({
      userId,
      email: claims.email || (profile && profile.email) || null,
      emailVerified: claims.emailVerified === true,
      displayName: profile ? (profile.display_name ?? null) : null,
      memberships,                                   // [] when none
      workspaces: memberships.map(m => m.workspaceId), // accessible workspace ids
      adminPinSetupRequired: anyPinRequired,         // server-derived; false when none/unknown
    });
  };
}

module.exports = { createAccountService };
