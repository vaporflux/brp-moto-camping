#!/usr/bin/env python3
"""Prove the Google match rules. Run: python3 build/test_match.py

build/enrich_google.py decides whether a Google result IS the OSM place it was searching
for. Get that wrong in one direction and a place is dropped that should have stayed; get it
wrong in the other and a campsite gets a phone number belonging to a different business,
which the rider will believe and dial.

The interesting cases are all real. They come from an actual 20-place trial run, which is
also where three bugs came from -- names stripped down to nothing, and a tie-break that
called 0.01 mi and 0.17 mi "equally plausible".
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))
import enrich_google as E  # noqa: E402

failures = []


def check(name, ok, detail=""):
    print(f"  {'pass' if ok else 'FAIL'}  {name}" + ("" if ok else f"   {detail}"))
    if not ok:
        failures.append(name)


def g(name, lat, lon):
    return {"id": "x", "displayName": {"text": name},
            "location": {"latitude": lat, "longitude": lon}}


def at(place, dmi, bearing_lon=True):
    """A coordinate `dmi` miles from a place, for building candidates."""
    return (place["lat"], place["lon"] + dmi / 54.6) if bearing_lon else \
           (place["lat"] + dmi / 69.0, place["lon"])


def main():
    print("names: a brand word is not noise")
    # The bug that started this: NOISE stripped "Inn", so "Days Inn" became "days".
    check("'Days Inn' matches 'Days Inn by Wyndham Waynesboro'",
          E.name_ratio("Days Inn", "Days Inn by Wyndham Waynesboro") >= E.MIN_NAME_RATIO,
          f"{E.name_ratio('Days Inn', 'Days Inn by Wyndham Waynesboro'):.2f}")
    check("'Holiday Inn Express & Suites' matches its full IHG name",
          E.name_ratio("Holiday Inn Express & Suites",
                       "Holiday Inn Express & Suites Waynesboro East by IHG")
          >= E.MIN_NAME_RATIO)
    check("Google's short trading name matches OSM's long official one",
          E.name_ratio("Fancy Gap / Blue Ridge Parkway KOA Journey",
                       "Fancy Gap KOA Journey") >= E.MIN_NAME_RATIO)
    check("'Rec Area' still matches 'Recreation Area'",
          E.name_ratio("Sherando Lake Rec Area (USFS)",
                       "Sherando Lake Recreation Area") >= E.MIN_NAME_RATIO)
    check("a different business scores low",
          E.name_ratio("Sherando Lake Rec Area (USFS)", "Blue Ridge Auto Parts")
          < E.MIN_NAME_RATIO)
    # "Girl Scout Camp" once collapsed to "girl scout" and matched a council office.
    check("a generic short name does not match a different organisation",
          E.name_ratio("Girl Scout Camp", "Virginia Skyline Girl Scout")
          < E.MIN_NAME_RATIO,
          f"{E.name_ratio('Girl Scout Camp', 'Virginia Skyline Girl Scout'):.2f}")
    check("but it does match its own camp",
          E.name_ratio("Girl Scout Camp", "Girl Scout Camp Sugar Hollow")
          >= E.MIN_NAME_RATIO)

    print("\ndistance decides what names cannot")
    P = {"name": "Sherando Lake Rec Area (USFS)", "lat": 37.9200, "lon": -79.0100}
    m, why = E.best_match(P, [g("Sherando Lake Recreation Area", 37.9214, -79.0100)])
    check("the same place a tenth of a mile away matches", m is not None, why)
    m, why = E.best_match(P, [g("Sherando Lake Recreation Area", 38.4800, -79.0100)])
    check("the same name 38 mi away does not", m is None)
    m, why = E.best_match(P, [g("Blue Ridge Auto Parts", 37.9205, -79.0100)])
    check("a different business at the same spot does not", m is None)
    # Real: Comfort Inn's nearest Google listing was 7.3 mi off, name score 1.00.
    m, why = E.best_match({"name": "Comfort Inn", "lat": 38.07, "lon": -78.90},
                          [g("Comfort Inn & Suites Staunton", 38.16, -79.02)])
    check("a perfect name 7 mi away is still refused", m is None, why)

    print("\nchoosing between candidates")
    K = {"name": "Fancy Gap / Blue Ridge Parkway KOA Journey",
         "lat": 36.6700, "lon": -80.6800}
    m, why = E.best_match(K, [g("Sherando Auto", 36.6701, -80.6800),
                              g("Fancy Gap KOA Journey", 36.6720, -80.6810)])
    check("picks the right name over the nearer wrong one",
          m and m["google_name"] == "Fancy Gap KOA Journey", why)
    m, why = E.best_match(K, [g("Fancy Gap KOA Journey", 36.6702, -80.6801),
                              g("Floyd / Blue Ridge Parkway KOA Holiday", 36.9350, -80.2280)])
    check("a sibling KOA 34 mi away never competes",
          m and m["google_name"] == "Fancy Gap KOA Journey", why)
    # Real: two Holiday Inn Express listings, 0.01 mi and 0.17 mi out. Seventeen times
    # nearer is an answer, not a tie.
    H = {"name": "Holiday Inn Express & Suites", "lat": 38.0700, "lon": -78.9000}
    near = at(H, 0.01)
    far = at(H, 0.17)
    m, why = E.best_match(H, [
        g("Holiday Inn Express & Suites Waynesboro East by IHG", *near),
        g("Holiday Inn Express & Suites Waynesboro-Route 340, an IHG Hotel", *far)])
    check("a decisively nearer listing wins instead of being called a tie",
          m and "East" in m["google_name"], why)
    # A genuine tie needs the OSM name to be neutral between the two candidates. When it
    # carries the distinguishing word itself -- "Journey" against "Holiday" -- that is
    # signal, and using it is not guessing.
    Kbare = {"name": "Fancy Gap KOA", "lat": 36.6700, "lon": -80.6800}
    a, b = at(Kbare, 0.01), at(Kbare, 0.02)
    m, why = E.best_match(Kbare, [g("Fancy Gap KOA Journey", *a),
                                  g("Fancy Gap KOA Holiday", *b)])
    check("two equidistant, equally-scoring names are refused, not guessed",
          m is None, why)
    m, why = E.best_match(K, [g("Fancy Gap KOA Journey", *a),
                              g("Fancy Gap KOA Holiday", *b)])
    check("but a distinguishing word in the OSM name settles it",
          m and m["google_name"] == "Fancy Gap KOA Journey", why)

    print("\nnothing to match")
    check("no results at all", E.best_match(P, [])[0] is None)
    check("a result with no coordinates is ignored",
          E.best_match(P, [{"id": "x", "displayName": {"text": "Sherando Lake"}}])[0] is None)

    print()
    if failures:
        print(f"{len(failures)} FAILED: {failures}")
        return 1
    print("all Google match-validation checks pass")
    return 0


if __name__ == "__main__":
    sys.exit(main())
