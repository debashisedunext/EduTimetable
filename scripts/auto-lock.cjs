/**
 * §29.8 — taking the auto-lock out of the way of a smoke that is about
 * something else.
 *
 * Publishing now LOCKS the timetable (`schools.lock_on_publish`, default true).
 * That is right for a school and inconvenient for every existing smoke, because
 * most of them publish in order to *have* a published week and then carry on
 * editing — a staffing apply, a board move, a second publish.
 *
 * ## Why disable rather than open a grant
 *
 * The realistic flow now includes an unlock, so a smoke that opened one would
 * be more faithful. It would also couple two features: a §29.8 regression would
 * break `test:staffing`, `test:drafts` and `test:electives` as well as
 * `test:locks`, and the failure would point at the wrong file. A suite should
 * fail for its own subject.
 *
 * `locks-smoke.cjs` is where the auto-lock, the grant and the refusals are
 * asserted — including the staffing apply on a locked timetable, which is the
 * exact flow these smokes stop exercising when they call this. Nothing is lost;
 * it is moved to the file that owns it.
 *
 * Never call this from `locks-smoke.cjs` or `freeze-smoke.cjs`. Those two ARE
 * about the lock: the first asserts the auto-lock directly, and the second
 * thaws by hand mid-replay for the same reason, in the open.
 */
const { createRequire } = require("node:module");

/**
 * Turn the auto-lock off for one school.
 *
 * Written straight through Prisma rather than an API route, because there is
 * deliberately no endpoint for it — it is a deployment-level setting, not
 * something a screen offers, and adding a route so a test could reach it would
 * be a product decision made by a test.
 */
async function disableAutoLock(prisma, schoolId) {
  await prisma.school.updateMany({ where: { id: schoolId }, data: { lockOnPublish: false } });
}

/** Same, for a school identified by the name prefix a smoke uses. */
async function disableAutoLockByPrefix(prisma, prefix) {
  await prisma.school.updateMany({
    where: { name: { startsWith: prefix } },
    data: { lockOnPublish: false },
  });
}

module.exports = { disableAutoLock, disableAutoLockByPrefix, createRequire };
