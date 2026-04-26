The web UI needs an overhaul.

Steps:

1. Graph visualizer.

Use this project as inperiation for implementing the app web implementation.
Main https://github.com/nostr-wot

Source: https://github.com/nostr-wot/nostr-wot

Add the https://github.com/nostr-wot/nostr-wot-sdk libary in the lib folder, no seperated package, as we need full control.

Browser Extension - We will not implement this, just use it in our application as the https://github.com/nostr-wot/nostr-wot uses it.
Make sure to take advanges of all features that it provides for the nostr-wot app as well.

It is specially important to implement the playground part from https://github.com/nostr-wot/nostr-wot as this the main focus.

For now just implement all the api as in nostr-wot and use the oracle url, specified in the nostr-wot.

When done, we should be able to login by the nostr-wot extension in the browser, and navigate the playground followers etc.
Optimal, there should be no difference between nostr-wot and this app on the playground.


2. Attestr
We need to add new trust event by UI 
Here we can draw inspiration from https://attestr.xyz/
https://github.com/dadofsambonzuki/attestr

As the playground provides the navigation, attestr provides the part where we can create new Trust event on visual way just like attestr.

When done, we will be able to create new trust events and se lists of trust events issued by an author (pubkey).


3. Graph intergration.

This is where we connect the Playground graph with the Trust Graph API.
There we need to re-evaluate the api, and the need functionality on the playground.
This step is not compleatly described yet.