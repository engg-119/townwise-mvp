## ADDED Requirements

### Requirement: An engine switch needs a significant win
The lab SHALL return the other engine's run over the current engine's only when the other engine's backtest weekly WAPE is at least 0.5 points lower on the same scored weeks, a one-sided Diebold-Mariano test on the two engines' weekly absolute errors over those weeks gives p under 0.10, and the other engine passes its checks. The test SHALL use a Newey-West (Bartlett) variance over 4 weeks of overlap and Student's t with T − 1 degrees of freedom, and SHALL never be significant with fewer than 12 shared weeks or with differences that do not vary. With no current run, the lab SHALL return the model only when it wins the baseline the same way, and otherwise the baseline, unless the chosen engine fails its checks and the other passes them. [CONFIRM: p under 0.10 one-sided, and the baseline as a first forecast's engine unless the model's win is significant]

#### Scenario: A large but noisy win does not switch
- **WHEN** the current run is a baseline run and the model is 1 point better on 41 backtest weeks at a one-sided p of 0.63
- **THEN** the lab returns the baseline's run

#### Scenario: A consistent win switches
- **WHEN** the current run is a model run and the baseline is more than 0.5 points better on the same weeks with p under 0.10, and it passes its checks
- **THEN** the lab returns the baseline's run

#### Scenario: A first forecast without a significant model win
- **WHEN** there is no current run and the model is 1.3 points better on 37 weeks at a one-sided p of 0.12
- **THEN** the lab returns the baseline's run

#### Scenario: Too few weeks
- **WHEN** the two engines share fewer than 12 scored weeks
- **THEN** no win is significant and the current engine, or with no current run the baseline, is returned
