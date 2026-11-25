# pb-tokei

Statistics on professional side-out-scored doubles pickleball (PPA, APP, MLP), derived from recorded broadcast footage, for understanding how pros win and lose rallies.

## Language

### Competition

**Tournament**:
A pro event on the PPA or APP tour, or an MLP event, containing many Matches.
_Avoid_: Event

**Match**:
A contest between two Teams, made of one or more Games.

**Game**:
One scored game within a Match, played with side-out scoring.

**Franchise**:
An MLP club of four or more Players that fields different Teams in different Matches.
_Avoid_: MLP team

**Franchise Match**:
An MLP contest between two Franchises, made of several Matches (each MLP doubles game is its own one-Game Match).
_Avoid_: MLP match

**Rally**:
Everything from a Serve until the ball is dead; the unit every stat is counted in.
_Avoid_: Point (for a Rally in general), exchange

**Point**:
A Rally that changes the score; under side-out scoring, only a Rally won by the Serving Team.

**Referee Call**:
What the referee announces when a Rally ends: "point" (the Serving Team won), "second server" or "side out" (the Receiving Team won).

**Challenge**:
A Player's request to review a call, ending in a ruling that either upholds the call or overturns it and changes who won the Rally.

**Opening**:
Shots 1 to 5 of a Rally: the Serve, Return, third, fourth and fifth Shots.
_Avoid_: early rally, first few shots

### People

**Team**:
The two Players on one side of the net in a Match; the same two Players form the same Team across Matches and Tournaments.
_Avoid_: pair, partnership, side

**Serving Team**:
The Team that serves in a given Rally.

**Receiving Team**:
The Team that receives the Serve in a given Rally.
_Avoid_: returner team, returning team, defense

**Server**:
The Player who hits the Serve.

**Returner**:
The Player on the Receiving Team who hits the Return.

**Target**:
The opponent a Shot is aimed at: the one who hits the next Shot, or for a Winner the one nearest where the ball crossed onto their side.

### Court

**Zone**:
One of three depth bands on each side of the net, measured by distance from the net and ignoring lateral position: Frontcourt, Midcourt, Backcourt.

**Frontcourt**:
The Zone from the net to 9 ft from the net: the kitchen plus 2 ft behind the kitchen line.
_Avoid_: kitchen (the kitchen is only the 7 ft non-volley zone), NVZ

**Midcourt**:
The Zone from 9 ft to 18 ft from the net.
_Avoid_: transition zone, no man's land

**Backcourt**:
The Zone from 18 ft from the net to beyond the baseline.
_Avoid_: baseline (that is the line, not the Zone)

### Shots

**Shot**:
One contact of the ball by a Player's paddle within a Rally.
_Avoid_: hit, stroke

**Shot Number**:
A Shot's position in its Rally, counting the Serve as 1.
_Avoid_: shot index

**Contact Zone**:
The Zone the hitter is standing in when they hit a Shot; not where the ball is or where it lands.

**Contact Kind**:
Whether a Shot was hit before the ball bounced (Volley) or after (Bounce).

**Shot Class**:
The recorded character of a Shot: Soft (pace taken off so the ball drops low), Hard (sent at or past the opponent, at any speed), Lob, or Overhead (hit above head height, swinging down).

**Attack**:
A Shot whose Shot Class is Hard or Overhead.

**Shot Type**:
The name of a Shot, worked out from its Shot Class, its Contact Zone, and whether the incoming Shot was an Attack; Serve and Return are fixed by Shot Number instead.

**Serve**:
Shot 1 of a Rally.

**Return**:
Shot 2 of a Rally.

**Dink**:
A Soft Shot from the Frontcourt when the incoming Shot was not an Attack.

**Block**:
A Soft Shot from the Frontcourt answering an Attack.

**Drop**:
A Soft Shot from the Midcourt or Backcourt when the incoming Shot was not an Attack.
_Avoid_: midcourt dink

**Reset**:
A Soft Shot from the Midcourt or Backcourt answering an Attack.

**Speedup**:
A Hard Shot from the Frontcourt when the incoming Shot was not an Attack.
_Avoid_: frontcourt drive

**Counter**:
A Hard Shot from the Frontcourt answering an Attack.
_Avoid_: frontcourt drive

**Drive**:
A Hard Shot from the Midcourt or Backcourt.

**Lob**:
A Shot of Shot Class Lob, from any Zone.

**Offensive Lob**:
A Lob hit while the hitter's Team is Established.

**Defensive Lob**:
A Lob hit while the hitter's Team is not Established.

**Overhead**:
A Shot of Shot Class Overhead, from any Zone.
_Avoid_: smash

**Winner**:
A Shot that goes in or hits an opponent, and that no opponent returns with the paddle.

**Error**:
Anything a Player does that loses the Rally for their Team: a Shot into the net or out, a kitchen fault, a double hit, or being hit by the ball; if a Player touches a ball and misses, the miss is that Player's Error.

**Error Kind**:
What an Error was: Net, Out, Kitchen Fault, Double Hit, or Body Hit (the Player was hit by the ball).

**Shot Outcome**:
Whether a Shot left the hitter's Team better placed (Advantage), worse placed (Disadvantage), or neither (Neutral), judged over the opponent's reply and the Team's follow-up.
_Avoid_: shot success, shot quality

**Put-away**:
An Attack whose very next result is a Winner or an opponent's Error.

**Popup**:
A Soft Shot whose reply is an Overhead or a Put-away.

**Speedup Exchange**:
A Speedup and the Counters, Blocks and Overheads that follow it, ending Won or Lost (the speeding-up Team wins or loses the Rally) or Neutral (a Soft Shot or Lob is played and the next Shot is not an Attack).
_Avoid_: hands battle, firefight

**Erne**:
A flag on a Shot hit from beside the kitchen, outside the sideline, including what is sometimes called a Bert.
_Avoid_: Bert

**ATP**:
A flag on a Shot that passes around the net post rather than over the net.
_Avoid_: around the post

### Rally Phases

**Team Status**:
Where a Team stands at a Shot's contact: Established, Split (one Player in the Frontcourt), or Back (neither).

**Established**:
The Team Status a Team gains when both Players are in the Frontcourt, and keeps until either Player goes deeper than 12 ft from the net.
_Avoid_: at the kitchen, at the line

**Settled**:
A Player who is in the Frontcourt and no longer moving toward the net at a Shot's contact.
_Avoid_: set, stable

**Arrival**:
The first contact in a Rally at which a Team is Established.
_Avoid_: kitchen arrival (as a separate idea)

**Rally Phase**:
The stage of a Rally at a given Shot, worked out from Shot Number and both Teams' Team Status: Serve, Return, Transition, Frontcourt Battle, or Scramble.

**Transition**:
The Rally Phase in which some Team has not yet been Established in the Rally.

**Frontcourt Battle**:
The Rally Phase in which both Teams are Established.
_Avoid_: frontcourt conflict, kitchen battle, dink battle

**Scramble**:
The Rally Phase in which a Team that was Established earlier in the Rally no longer is; it takes precedence over Transition.

### Recording

**Camera View**:
The broadcast camera a stretch of footage comes from; the Main View (high, behind one baseline, showing the whole court) and the Sideline View (low, from the side at the kitchen) are the ones that count as live play.

**Play Segment**:
A stretch of broadcast showing live play from the Main View or Sideline View, with replays, crowd shots, close-ups and graphics removed.
_Avoid_: clip

**Landmark**:
One of 12 court-line intersections clicked on the video to calibrate a Camera View: where the centreline and each sideline meet each baseline and each kitchen line, named near or far and left or right as seen from the Main View camera.
_Avoid_: keypoint, corner (only some Landmarks are corners)

**Calibration**:
The Landmarks clicked in one Camera View (each recording the frame it was clicked on, or marked not visible), mapped back to the Calibration's reference frame via Camera Motion and fitted to map points on the court surface between the video and the court; it is in effect from a given frame until the next Calibration of that view, and its mapping follows the camera's movement via Camera Motion.

**Camera Motion**:
The derived frame-by-frame homography tracking how a Camera View pans and zooms relative to its Calibration's reference frame within a Play Segment, with the camera lens's distortion; combined with the Calibration's Landmark fit, it maps each frame to the court, or maps to nothing when a frame cannot be registered.

**Roster File**:
The hand-written TOML file that sets up one Match: its Tournament, Teams, Players and optional Franchise Match and source video.

**Rally Log**:
The record of every Rally and Shot in a Match, holding only Observed and Inferred facts, including where all four Players stand at each Shot.

**Gold Annotation**:
Careful manual annotation of a Match with no time limit, producing benchmark and training data.

**Gold Set**:
The fixed group of Gold-Annotated Matches used only to measure the system, never to train it.

**Assisted Annotation**:
Annotation in which the system pre-fills the Rally Log and an operator confirms or fixes it.

**Operator Time Ratio**:
Operator minutes spent on a Match divided by its full broadcast minutes.

**Observed**:
A fact seen on screen.

**Inferred**:
A fact not seen but implied by what was seen or by the rules of the game, such as a Serve being in because the Rally continued.

**Unknown**:
A fact neither seen nor implied.

**Derived**:
A judgment computed from the Rally Log by a written rule, such as whether an error was unforced; never stored in the Rally Log.

**Observation Gap**:
A part of a Rally in which Shots happened but were not seen; whether an odd or even number of Shots is missing is known, the count is not.
