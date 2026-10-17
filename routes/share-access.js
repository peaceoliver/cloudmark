/**
 * Ki láthat és ki szerkeszthet egy `items` sort: a tulajdonos, vagy akinek elfogadott megosztása van rá
 * (közvetlenül, vagy feladatnál a szülőfeladaton keresztül). Minden olyan lekérdezés ezt használja,
 * amely megosztott elemet is visszaadhat, így a jogosultság egy helyen dől el.
 */

const SHARE_PERMISSIONS = ['view', 'edit'];
const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

/** Lower-cased, trimmed e-mail address, or null when it is not a plausible address. */
function normalizeEmail(value) {
    const email = String(value ?? '').trim().toLowerCase();
    return email.length <= 255 && EMAIL_PATTERN.test(email) ? email : null;
}

function normalizePermission(value) {
    return SHARE_PERMISSIONS.includes(value) ? value : null;
}

/**
 * Joins the viewer's accepted share of item `i` as `sh` and the viewer's effective state as `v`
 * (category_id, archived, pinned, starred): the owner sees the item's own columns, a recipient the
 * columns of their share row. A subtask seen through its parent has no personal state.
 * `viewer` is a SQL parameter placeholder such as `$1`.
 */
function viewerJoinSql(viewer) {
    return `
        LEFT JOIN LATERAL (
            SELECT s.id, s.permission, s.recipient_category_id, s.recipient_pinned, s.recipient_starred, s.recipient_archived,
                   (s.item_id = i.id) AS direct
            FROM shares s
            WHERE s.recipient_user_id = ${viewer} AND s.status = 'accepted' AND s.item_id IN (i.id, i.parent_item_id)
            ORDER BY (s.item_id = i.id) DESC, (s.permission = 'edit') DESC
            LIMIT 1
        ) sh ON i.owner_user_id <> ${viewer}
        CROSS JOIN LATERAL (
            SELECT CASE WHEN sh.id IS NULL THEN i.category_id WHEN sh.direct THEN sh.recipient_category_id END AS category_id,
                   CASE WHEN sh.id IS NULL THEN i.archived ELSE sh.direct AND sh.recipient_archived END AS archived,
                   CASE WHEN sh.id IS NULL THEN i.pinned ELSE sh.direct AND sh.recipient_pinned END AS pinned,
                   CASE WHEN sh.id IS NULL THEN i.starred ELSE sh.direct AND sh.recipient_starred END AS starred
        ) v`;
}

/** WHERE condition (needs viewerJoinSql): the viewer owns the item, or it is shared with them and not in the owner's trash. */
function visibleSql(viewer) {
    return `(i.owner_user_id = ${viewer} OR (sh.id IS NOT NULL AND i.trashed = FALSE))`;
}

/** Stand-alone condition: item alias `alias` is the viewer's own or shared with them (directly or via its parent). */
function canSeeItemSql(alias, viewer) {
    return `(${alias}.owner_user_id = ${viewer} OR EXISTS (
        SELECT 1 FROM shares vs WHERE vs.recipient_user_id = ${viewer} AND vs.status = 'accepted'
          AND vs.item_id IN (${alias}.id, ${alias}.parent_item_id)))`;
}

/** Extra columns for item rows: who may do what, and the share badge data. */
function shareColumnsSql(viewer) {
    return `CASE WHEN sh.id IS NULL THEN 'owner' ELSE sh.permission END AS access,
            sh.id AS share_id, COALESCE(sh.direct, FALSE) AS share_direct,
            CASE WHEN sh.id IS NULL THEN NULL ELSE (SELECT u.username FROM users u WHERE u.id = i.owner_user_id) END AS shared_by,
            CASE WHEN i.owner_user_id = ${viewer}
                 THEN (SELECT COUNT(*) FROM shares s2 WHERE s2.item_id = i.id AND s2.status <> 'declined')::int ELSE 0 END AS share_count,
            v.category_id AS v_category_id, v.archived AS v_archived, v.pinned AS v_pinned, v.starred AS v_starred`;
}

/** Replaces the item's own state columns with the viewer's effective ones (from shareColumnsSql). */
function presentItem(row) {
    if (!row) return row;
    const { v_category_id, v_archived, v_pinned, v_starred, ...item } = row;
    return { ...item, category_id: v_category_id, archived: v_archived, pinned: v_pinned, starred: v_starred };
}

/**
 * What the user may do with an item: { id, type, owner_user_id, parent_item_id, updated_at, access, share_id, direct },
 * where access is 'owner', 'edit' or 'view'; null when the user cannot see it.
 */
async function itemAccess(db, itemId, userId) {
    const result = await db.query(
        `SELECT i.id, i.type, i.owner_user_id, i.parent_item_id, i.category_id, i.updated_at,
                CASE WHEN sh.id IS NULL THEN 'owner' ELSE sh.permission END AS access,
                sh.id AS share_id, COALESCE(sh.direct, FALSE) AS direct
         FROM items i ${viewerJoinSql('$2')}
         WHERE i.id = $1 AND ${visibleSql('$2')}`,
        [itemId, userId]
    );
    return result.rows[0] || null;
}

/** Whether a save based on `expected` (the updated_at the client loaded) would overwrite a newer change. */
function isStaleSave(currentUpdatedAt, expected) {
    if (expected === undefined || expected === null || expected === '') return false;
    const expectedTime = new Date(expected).getTime();
    if (Number.isNaN(expectedTime)) return false;
    return new Date(currentUpdatedAt).getTime() > expectedTime;
}

module.exports = {
    SHARE_PERMISSIONS,
    normalizeEmail,
    normalizePermission,
    viewerJoinSql,
    visibleSql,
    canSeeItemSql,
    shareColumnsSql,
    presentItem,
    itemAccess,
    isStaleSave
};
