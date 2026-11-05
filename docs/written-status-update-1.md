# Written Status Update 1

**Group 3:** Marianna Cardin, Cameron Keith, Tejus Rajashekar, and Katie Sellu
**Course:** AI in the Real World
**Date:** 10/26/2026

## Updates to Problem Statement

From our initial proposal, we were able to schedule meetings with the Sawtooth owner, Kieran, and former manager, Laney, to better understand the pain points restaurants face. These conversations lead us to identifying a key limitation of existing restaurant forecasting tools: they do not adequately capture the highly localized patterns of smaller towns like Hanover. Sawtooth currently uses Toast, which only provides broad regional demand mapping. Restaurant demand in Hanover is heavily influenced by factors such as Dartmouth's academic calendar, sporting events, campus activities, tourism, and seasonal population changes.

Therefore, we propose shifting our focus toward an agentic system that autonomously researches a locality, discovers unique demand drivers, and constructs a location-specific forecasting model. Rather than relying primarily on historical sales trends, the system would use publicly available information to characterize local demand and then calibrate its predictions using restaurant-specific historical data.

Additionally, these discussions helped us narrow the application to bar inventory management because this location-specific forecast can make more of a difference for smaller businesses like Sawtooth. We plan to have our system's forecasts also be used to set reorder points and optimize order quantities for drink inventory.

## Updates on Design and Architecture

For our design, we will combine five components:

1. An AI agent that autonomously researches a locality, identifies its unique demand drivers, and gathers relevant external data (Dartmouth specific events) to construct a location-specific demand profile.
2. An AI agent that uses the locality profile to engineer features, select modeling approaches, and independently train, evaluate, and refine machine learning models to forecast customer demand over 7, 28, and NTM horizons.
3. A system that incorporates available historical sales and transaction data to calibrate forecasts for individual restaurants and improve accuracy as additional data becomes available.
4. An AI agent that translates demand forecasts into explainable recommendations for inventory replenishment, and purchasing.
5. A full-stack app (React Native frontend, node.js backend, LangGraph)

Our design is informed by the interviews we had with the owner, and former manager and also Sawtooth's toast data that spans two years back in six-month increments. The data includes sales breakdowns, sale summaries, product mix of quantity sold by item, average price, discount price, tax amount, and refund amount.

## Progress Against Implementation

Over the last week, our team has reviewed the proposal feedback, and decided to revise the scope of our project. After meeting with the professors to discuss some potential ideas, we thought about directing our focus to local businesses and how we could help them with demand forecasting. We arranged two interviews with Sawtooth current and past management to learn more about their processes and main challenges. Following these meetings, our team has met up to brainstorm our new project direction, plan next steps of implementing data, and assign different responsibilities to each team member.

## Problems Encountered

Our proposal feedback mentioned that our original idea was too broad and was already widely developed in the world of logistics. To make our project more compelling, we needed to find a way to differentiate our model from the ones that are currently used by most businesses in the restaurant/bar industry, such as Toast. We decided to pivot towards smaller businesses in Hanover, and how we could personalize a tool to forecast demand and help inform supply chain decisions. After meeting with Sawtooth's owner, we were told that a model to forecast their traffic would be more helpful, especially taking into account Dartmouth College's numerous events that affect local businesses. He addressed the pain points they experience with Toast, notably its lack of localized knowledge about towns like Hanover, as it only offers broader regional information. With this conversation in mind, our team is adjusting our project to focus on forecasting traffic/demand for small businesses in Hanover.

Additionally, we encountered a few data challenges. First, the Toast data is broken into six-month periods, which makes it difficult to map demand to specific weekly events such as homecoming, parents' weekend, etc. Second, the data needs to be cleaned up as not every item has a date attached. This also will make it hard to link the items and sales to specific time periods and events. Third, we must find a way to segment the sales and transactions data into three types of nights: Sawtooth-hosted events, regular dining, and special Dartmouth events. Each can change how much customers drink and which drinks they order more. With our analysis, we would need to determine which factors have the greatest impact on the demand, so our system knows the biggest demand drivers and our system becomes more credible.

## Open Questions We Want to Address

1. Can an autonomous ML agent discover, construct, and calibrate locality-specific demand forecasting models that outperform generalized forecasting approaches, particularly in data-scarce markets?
2. How much restaurant-specific historical data is required to adapt a locality-aware model to an individual business?
3. How useful will Sawtooth's historical data be?
4. How precisely can we estimate demand without Sawtooth's data? Could we adapt a generalized forecasting model based on publicly available information to predict the demand for restaurants at a specific time (e.g., Sawtooth)? What features could we identify for the generalized model (e.g., we could use events instead of dates or try to find leading indicators)? What alternative data could we utilize to create these leading indicator features?

## Comments

> Thanks for the update, I'm excited by how you all have refined your scope. Do you have a sense yet of what publicly available data will be most useful for predicting the hyper local demand swings? Also what outcomes will change as a result of your improved forecasting - are you helping Sawtooth determine more fine-tuned labor scheduling, or reducing inventory overhead? Do they ever run out of inventory? Just curious how your work will hit the Sawtooth owner's bottom line.
>
> ~ Laura
