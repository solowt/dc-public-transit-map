-  add direction labels to buses only while filtered (N/S/E/W)
-  update arrivals list in place: only add new arrivals/remove old ones
-  select no passenger trains when they appear in arrivals
-  better zoom to entrances / bus stops
-  Handle this arrival pattern ("Tain"):

{
    Car: "8",
    Destination: "Train",
    DestinationCode: null,
    DestinationName: "Train",
    Group: "2",
    Line: "--",
    LocationCode: "E06",
    LocationName: "Fort Totten",
    Min: "ARR"
  }

  -  Handle this arrival pattern (no code!):

  {
    Car: "6",
    Destination: "Greenbelt",
    DestinationCode: null,
    DestinationName: "Greenbelt",
    Group: "1",
    Line: "GR",
    LocationCode: "E06",
    LocationName: "Fort Totten",
    Min: "ARR"
  }

  -  Add new tab for Alerts: open/close socket based on tab -- same tabvisibility rules as trains/buses - add 3 new wmata endpoints, concat them into one data stream with 3 props on it -- use accordions + calcite lists to segregrate 3 alert types