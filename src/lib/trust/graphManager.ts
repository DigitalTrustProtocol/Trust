import { VerifiedEvent } from "nostr-tools";
import { Graph } from "./graph/Graph.js";
import { getStore, Store } from "../db/dbManager.js";
import { asTrustEvent, isTrustEventValid, KIND_TRUST } from "../nostr/nip32010.js";
import { NStore } from "@nostrify/nostrify";
import { KIND_DELETE_REQUEST_EVENT as KIND_DELETE_REQUEST } from "../nostr/nip09.js";
import { KIND_USER_METADATA } from "../nostr/nip01.js";
import { getPublicKey } from "../../config.js";


let graph: Graph | null = null;


export async function getGraph(): Promise<Graph> {
    //if (!graph) {
    //    graph = await Graph.loadFromFile();
    //}
    return graph!;
}

export async function insertEvent(event: VerifiedEvent, opts?: { store?: Store, graph?: Graph }): Promise<boolean> {

    let store = opts?.store === undefined ? await getStore() : opts?.store;
    let graph = opts?.graph === undefined ? await getGraph() : opts?.graph;

    if (event.kind === KIND_TRUST) {
        return await insertTrustEvent(event, store, graph);
    }
    if (event.kind === KIND_USER_METADATA) {
        return await insertUserMetadataEvent(event, store, graph);
    }


    // Do we need to support delete events, or just ignore them?
    if (event.kind === KIND_DELETE_REQUEST) {
        return false;
    }


    return false;
}

async function insertTrustEvent(event: VerifiedEvent, store?: Store, graph?: Graph): Promise<boolean> {
    const trustEvent = asTrustEvent(event);
    if (!isTrustEventValid(trustEvent)) return false;

    let opt = { };
    await store?.event(trustEvent, opt);

    //let inserted = (opt as any).isInserted ?? false;
    //let deleted = (opt as any).isDeleted ?? false;


    let inserted = false;
    if(graph) {
        inserted = graph.applyTrustEvent(trustEvent);
    }
    
    //if(graph && deleted)  {
    //    graph.removeTrustEvent(trustEvent);
    //}

    return inserted;
}

async function insertUserMetadataEvent(event: VerifiedEvent, store?: Store, graph?: Graph): Promise<boolean> {
    let opt = { };
    await store?.event(event, opt);

    let inserted = (opt as any).isInserted ?? false;
    let deleted = (opt as any).isDeleted ?? false;

    if(graph && inserted) {
        graph.applyUserMetadataEvent(event);
    }

    return inserted;
}

export async function loadGraph(store: Store, author: string = '*', maxDepth: number = 2): Promise<Graph> {
    if (graph) return graph;
    if (!graph) {

        //graph = await Graph.loadFromFile();
        graph = new Graph();

        if(author === 'default') {
            author = getPublicKey();
        }

        if(author === '*') {
            await getGraphFromDBAllAuthors(store, graph);
        } else {
            await getGraphFromDB(author, maxDepth, store, graph);
        } 
    }
    return graph;
}


async function getGraphFromDBAllAuthors(store: Store, graph: Graph): Promise<void> {
    let events = store.allEvents(KIND_TRUST);

    for await (const event of events) {
        const trustEvent = asTrustEvent(event as VerifiedEvent);
        graph.applyTrustEvent(trustEvent);
    }
}

async function getGraphFromDB(author: string, maxdepth: number = 2, store: NStore, localGraph: Graph): Promise<void> {
    let visited: Set<string> = new Set<string>();

    var queue = [author];
    let degree = 0;
    let nodeIndex = 0;

    while (queue.length > 0 && degree < maxdepth) {
        let degreeLength = queue.length;
        degree++;

        while (nodeIndex < degreeLength) {

            let author = queue[nodeIndex++];

            const events = await store.query([{ authors: [author!], kinds: [KIND_TRUST] }]);

            for (const event of events) {
                const trustEvent = asTrustEvent(event as VerifiedEvent);
                localGraph.applyTrustEvent(trustEvent);
            }

            let subjects = localGraph.trustedSubjects(author!); // All contexts
            for (const subject of subjects) {
                if (!visited.has(subject)) {
                    visited.add(subject);
                    queue.push(subject);
                }
            }
        }
    }
}



function* chunksOf(arr: string[], size: number): Generator<string[], void, unknown> {
    for (let i = 0; i < arr.length; i += size) {
        yield arr.slice(i, i + size);
    }
}
