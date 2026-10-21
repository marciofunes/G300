# Image analysis: GROB G300 machining center (reference g300-reference.jpg)

## Layer 1 Identification
- Work type: horizontal 5-axis machining center, enclosed, modular series (GROB G-module G300).
- Broad class: industrial machine tool / hard-surface mechanical assembly.
- primaryDomain: object. Confidence 0.95.

## Layer 2 Form and silhouette
- Bounding volume: one long cuboid enclosure, footprint aspect ~2.3 : 1 (long axis runs from the
  work-area face to the aggregate end), height ~1.15x the short side.
- Reference dimension: short side (front face) ~1.75 m; long side ~4.0 m; height ~2.9 m
  (inference from GROB weight/class and visible proportions).
- Symmetry: asymmetric. Shape language: geometric (cuboids, cylinders, extruded profiles).

## Layer 3 Macro / meso / micro
- Macro: enclosure body; top perimeter frame (blue band); roof housing over Z/Y slides;
  work area (front-left corner); aggregate bay (rear end of long side); rear-top coolant /
  filter module (inclined frame with horizontal cylindrical tank); operator panel on swivel arm;
  chip conveyor / chip outlet block (front, below work area).
- Meso: sliding door with frosted window panel; trunnion cradle (A axis) with rotary pallet
  table (B axis); horizontal motor spindle with HSK nose emerging from the column wall; telescopic
  way covers; disc tool magazine (hidden behind roof housing, inferred); two inspection windows on
  long side; arched black service cut-out; hydraulic unit (finned tank + vertical motor pump);
  coolant pump (vertical motor on shelf); high-pressure pump unit (low left of bay); piping;
  floor duct; GROB badge; "G300" lettering.
- Micro: table T-slot / hole pattern; screw rows on panels; door handles (black, vertical);
  keypad, red emergency stop, screen; motor cooling fins.

## Layer 4 Spatial relationships
- <blue band, caps, enclosure walls> (overlap, flush with outer faces).
- <roof housing, sits on, enclosure top centre line> (butt).
- <spindle, embedded-in, column wall facing work area> (socket), axis horizontal along long axis.
- <trunnion cradle, below and in front of, spindle>; <rotary table, inside, cradle> (socket).
- <operator panel, attached-to, swivel arm, attached-to, long side near work area> (socket).
- <aggregate bay, inside, rear end of long side, open (doors removed)>.
- <hydraulic unit, on floor of, aggregate bay>; <coolant pump, on shelf of, aggregate bay>.
- <coolant module (tank), above, roof at rear end> on inclined frame.

## Layer 5 Materials (PBR)
- Enclosure panels: dielectric painted sheet, base color light warm grey, roughness ~0.55, metal 0.
- Blue band: painted sheet, vivid blue mid-low value, roughness ~0.5.
- Spindle nose, table top, way covers: steel, metalness 0.9, roughness 0.3 to 0.45.
- Windows: dark tinted glass, low roughness, semi-transparent.
- Motors / pumps: painted light grey cast, roughness 0.5; fins as repeated extrusions.
- Black parts (handles, cut-out, E-stop ring): dark dielectric, roughness 0.6.

## Layer 6 Color and finish
- Light grey satin (dominant ~70 %), vivid blue satin band (~12 %), steel (~8 %), black accents,
  operator screen bright cyan / white UI, red E-stop.

## Layer 7 Identity features
- Blue top perimeter band with GROB badge; large italic "G300" lettering on front face.
- Open work area showing horizontal spindle above a trunnion swivel table (key G-series concept).
- Operator panel on swivel arm at the long side corner.
- Exposed aggregate bay with vertical motor pumps and finned hydraulic tank.
- Rear-top inclined module with horizontal cylindrical tank.

## Layer 8 Uncertainty
- Hidden: rear face and the far long side; disc tool magazine (hidden under roof housing);
  chip conveyor run length (occluded); internal X/Y/Z slide layout (inferred from GROB concept:
  axes split between tool side and workpiece side).
- Model will mirror visible panel rhythm onto hidden faces and flag them as low confidence.
- Pump identities are assigned for the demo: coolant (refrigeração), hydraulic (hidráulica),
  high-pressure (alta pressão). This is a demo convention, not measured.
