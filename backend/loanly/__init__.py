"""Loan-ly Planet backend: climate-risk monitoring and IFRS 9 expected credit loss for agricultural loans.

Pipeline (see docs/METHODS.md): fetch/clean satellite + weather series -> crop stage -> anomalies (z, SPI) ->
rule-based stress -> analog seasons -> stress-to-yield regression -> PD/LGD/EAD/ECL -> portfolio risk -> alerts.
"""
