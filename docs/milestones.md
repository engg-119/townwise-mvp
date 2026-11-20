# Milestones

Planned by week, in this order.

## 1. Locality Research and Data Collection

- Finalize access to Sawtooth's historical sales and transaction data
- Develop the locality research agent to identify Hanover-specific demand drivers (town research, spec D66: weekly web research of each town and each restaurant in parallel threads, its findings on the Calendar with their sources; `docs/portal/tuning-chat.md` section 10)
- Identify and collect publicly available datasets
- Set up app scaffold

## 2. Autonomous ML Development

- Develop the ML agent to autonomously engineer features, select forecasting algorithms, and train candidate models
- Establish traditional forecasting baselines using historical sales, seasonality, and rolling averages
- Build an automated experimentation pipeline for evaluating and refining model performance

## 3. Calibration and Forecasting

- Integrate Sawtooth's historical data to calibrate the agent-generated models
- Generate demand forecasts with uncertainty estimates, and rationales
- Test models with varying amounts of historical data

## 4. Evaluation and Final Deliverables

- Deploy the system at Sawtooth as a case study
- Refine the agentic pipeline based on experimental results
- Complete the final report, documenting methodology, results, limitations, and opportunities for generalization to other localities
