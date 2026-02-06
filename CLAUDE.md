# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Deno-based server for WMATA (Washington Metropolitan Area Transit Authority) train data.

## Commands

- **Run dev server:** `deno task dev` (runs main.ts with watch mode)
- **Run tests:** `deno test`
- **Run single test file:** `deno test main_test.ts`
- **Type check:** `deno check main.ts`

## Architecture

- **Runtime:** Deno (uses JSR for package imports)
- **Entry point:** main.ts
- **Test convention:** Tests are co-located with source files using `_test.ts` suffix

## Project description

The goal of this project is to create a server that uses the WMATA API to calculate wmata train positions (longitute, latitude) and provide this information to clients.

The WMATA API does not provide geographic locations but it does provide the circuit id that each train is on. The API further provides a "circuit map" which includes which circuit each station is located on and the series of circuits used to move between stations. It also provides the geographic location of each station.

Using this information, and assuming (for now) that the tracks between each station are straight lines and each circuit is the same length, we can roughly calculate the geographic location of each train from its circuit id.

The train locations will be provided via web socket (so the server will need to accept requests and include an endpoint to upgrade to web sockets). The server will poll the WMATA API at some interval, calculate the location of each train, and provide updates to all connected users. More details:

- When a user initially connects on a web socket, they should immediately be sent the train data for all active trains in the form of a JSON array
- After connection, only when a given train switches circuits should the user recieve an update for that train. All updates should be in the form of a JSON array
- The arrays in question will include all data that the WMATA API provides by default *plus* a object representing the train's geographic location in the form of an oject with latitude and longitude properties
- The API key for the WMATA API is located in the .api-key file

## Scripts

The scripts directory will contain typescipt files contain building blocks of the server.

- The `generate_map.ts` file should export a function that creates a complex JSON file containing a complete map of the WMATA rail system and all circuits. The server will load this file into memory when it starts and use it to calculate latitude and longitude
- The `wmata-api.ts` file will export a series of functions for interacting with the wmata API (see section below on which functions to include)


## Relevant WMATA APIs

The main site for the WMATA APIs is https://developer.wmata.com/apis

Train positions: https://developer.wmata.com/api-details#api=5763fa6ff91823096cac1057&operation=5763fb35f91823096cac1058 - (each train has a `circuitId` property )
Circuits: https://developer.wmata.com/api-details#api=5763fa6ff91823096cac1057&operation=57641afc031f59363c586dca - (circuits representing a station have a `stationCode` property)
Stations: https://developer.wmata.com/api-details#api=5476364f031f590f38092507&operation=5476364f031f5909e4fe3311 - (each station has a `stationCode` property which can be matched to the circuit `stationCode`)


## Train JSON schema

{
    "TrainId": "100",
    "TrainNumber": "301",
    "CarCount": 6,
    "DirectionNum": 1,
    "CircuitId": 1234,
    "DestinationStationCode": "A01",
    "LineCode": "RD",
    "SecondsAtLocation": 0,
    "ServiceType": "Normal"
    "location":  {
    	"latitude": Y,
    	"longitude": X
    }
}