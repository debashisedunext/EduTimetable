-- §19.1 — "this subject is always taught in its own room".
--
-- §19 gave the solver three ways to choose a room: a mapping's `preferred_room`
-- (one class's one subject), a lab subject's mapped labs, and otherwise the
-- class-section's home room. What no school could say was the ordinary middle
-- case: Music happens in the Music Room, for everybody, and it is not a lab.
--
-- ONE column, and deliberately no room id beside it. Which room(s) a subject
-- uses is already recorded — `room_subjects` has said "this room serves these
-- subjects" since §19, and it is what stops a biology period being sent to the
-- physics lab. A `subjects.room_id` column next to it would be a second answer
-- to "where does Music happen?", free to disagree with the first, and both feed
-- the same solver. It would also be a worse answer: a school with two music
-- rooms cannot say so in a single foreign key, and `room_subjects` already can.
--
-- So the flag says WHETHER, and the existing table says WHERE. The Subjects
-- screen edits both — which is what a person asked for — while the database
-- keeps one source of truth.
--
-- Default false: every existing school keeps exactly today's behaviour, and a
-- lab subject keeps taking labs through the path it always used.

ALTER TABLE `subjects`
  ADD COLUMN `taught_in_own_room` BOOLEAN NOT NULL DEFAULT false AFTER `is_lab`;
