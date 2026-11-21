# Sokoban solver — push-optimal, room by room

An entry for make.fun's `sokoban-solver-01-run-20261121`: one program,
`main.ts`, that answers every Sokoban level of a set in as few pushes as
possible.

## How it works

Every level the competition draws is a hallway one square wide with one to
four rooms off it. A box pushed out of a room through its door can never
come back, so a level's push-optimal count is the sum of its rooms' optima
and each room can be solved on its own. The program therefore:

1. reads the level and splits it into the hallway row and the rooms off it
   (a room is a connected stretch of floor off the hallway, with one door);
2. walks the player to each room's door in turn;
3. solves the room with A* over pushes — a state is the player's square
   plus the room's boxes, each action is one push, and the estimate is the
   cheapest assignment of boxes to goals under push-distances that ignore
   other boxes. Squares from which no goal can be reached by pushing are
   cut off before the search wastes time on them;
4. walks the player back out through the door and on to the next room.

The search budget is counted in expanded states, never in wall-clock time,
so two runs always write the same bytes. A level that does not have the
generator's shape falls back to one push-optimal search over the whole
board.

## Results on the practice set

| instance | pushes | optimal | points |
|----------|--------|---------|--------|
| i001 | 13 | 13 | 1,000 |
| i002 | 16 | 16 | 1,000 |
| i003 | 29 | 29 | 1,000 |
| i004 | 47 | 47 | 1,000 |
| i005 | 60 | 60 | 1,000 |

Score **1,000,000** — every instance solved in its push-optimal count.
The house baseline, plain-astar 1.0.0, scores 200,000 on the same set
(it gives up on four of the five instances). The solver was also checked
on three freshly drawn sets from the kit's own generator
(1,000,000 on each) and writes byte-identical outputs on repeated runs.

## Running it

Node 22 runs `node main.ts`. It reads `/input/<id>/level.txt` for every
instance id and writes `/output/<id>/solution.txt`, the player's moves in
`u`, `d`, `l`, `r`. For local runs the kit's starter convention applies:

```
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

No dependencies, no network, no clock reads — the whole set runs in under
a second on the practice data.
