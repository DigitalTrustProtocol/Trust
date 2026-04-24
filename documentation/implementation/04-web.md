@documentation/implementation/04-web.md This plan for the web part of the app.
Some of the web application have been made already, so the focus is for the graph integration.
The existing implementation of the graph visualisation is old and should be removed.

This plan is about the design of the functionality of the graph visualisation and resolve page.
I will list some of the requirements and functionality, however you welcome to add to the design, if things are missing or important.

The purpose is to make a design document that you will be able to build and implement from.

My requirements and features.
All communication goes to the relay and api.
The client browser can use other relay server for data. But for API functionality only localhost / trust.dance can be used.

1. A graph page that is used for navigation of the graph feely. 
The graph visualization window should be able to expand to full browser window.
The starting point for the graph are:
A.: Full graph. Load every node from the relay server. 
B.: Load from a specific pubkey, this should be selecteable as a searchable dropdown (Author select). Where one can search for pubkey and name. The default values in the dropdown, are predefined from as server pubkey, are previuse found and use pubkeys.
When a pubkey have been selected, clear the graph visualization, and load the pubkey and its trusted network.
Start with one degree out. When a node is selected, it will try to load its trust event for visualization as lazy load.
The resolve search field (subject select) for target subject is filled with the name or pubkey of selected node.
Each node name is from meta data or the short pubkey.. First 5 and  larst 5 characters.

A Resolve input field should be present (Subject Select). This field are the same searchable drowdown as the "Author select"
When both author and subject select are valid, the resolve button enables.
When a resolve is done switch the graph view to the result of the this query.
The visualization is author on the left with edges going right until subject. 
This is an ideal visualzation of the Resolve graph see picture.
However the pictures and names only works if the pubkeys have issued kind 0 events, and they contain the need information. 
Im currently debating with myself if I should provide an indentity api, for fast access to this information.
However its currently not implemented and therefore the client browser have to find it by relays servers and store data locally on client machine.

2. It should be posivle, to login on the web site, purly client side. Support simple login with cookie and private key stored in local browser store. And 

