# Northwind Sensors — firmware

Sample project so the voice agent has something real to read.

## What this is
Firmware for the NW-100 soil-moisture sensor. Reads capacitance every
30 seconds, averages over a 5-minute window, and reports over LoRaWAN.

## Layout
- `src/` — C sources (not included in this sample)
- `docs/` — protocol notes
- this README

## Status
Battery life is the open problem: current draw in deep sleep is ~40µA,
target is under 15µA. Suspect the RF module isn't fully powering down.
